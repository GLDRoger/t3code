#!/usr/bin/env bash
# Zoya asks Chief of staff to remind her: it is set, comes due in her own chat (not the owner's),
# rings her phone, and she taps Done herself. Her own reminders she moves and cancels by asking; the
# owner's she can't. A reminder for someone else, or one that starts work, is refused on her
# turn. Due, her card offers Change, Snooze and Tomorrow 9:00 too, and each works for her. Waits
# about a minute of real time: stored reminders keep their own due time, so `kv clock advance`
# would leave them stale.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
CHIEF="$(q "select agent_id from kin_leads where domain = 'chief' limit 1")"
CHAT="$(q "select chat_id from kin_chats where direct_key = '$ZOYA:$CHIEF'")"
OWNER_CHAT="$(q "select owner_chat_id from kin_leads where agent_id = '$CHIEF'")"
WHAT="Proof m$RUN: send the Lumen mockups"
at() { node -e 'process.stdout.write(new Date(Date.now()+(+process.argv[1])*1000).toISOString().replace("Z","+00:00"))' "$1"; }
DUE="$(at 60)"
# defer <what> <onDue> <chat> <say> [replaces] [as]
defer() {
  local input="{\"what\":\"$1\",\"due\":\"${LATER:-$DUE}\",\"onDue\":\"$2\",\"chatId\":\"$3\",\"sourceEventId\":\"\$event\"${5:+,\"replaces\":\"$5\"}}"
  kv tool chief kin_defer "$input" --as-turn-of "${6:-zoya}" --say "$4" 2>&1
}
cancel() {
  local input="{\"itemId\":\"$1\",\"sourceEventId\":\"\$event\"}"
  kv tool chief kin_cancel "$input" --as-turn-of zoya --say "$2" 2>&1
}
item_of() { rg -o 'def-[0-9a-f]+' <<<"$1" | head -1; }
run_state() { q "select state from kin_deferral_runs where item_id = '$1'"; }
wait_state() {
  for _ in $(seq 1 15); do
    [[ "$(run_state "$1")" == "$2" ]] && return 0
    sleep 1
  done
  fail "$3 (state $(run_state "$1"), not $2)"
}
device="{\"token\":\"$(printf 'e%.0s' {1..64})\",\"platform\":\"ios\",\"apsEnvironment\":\"development\"}"
kv as zoya rpc kin.push.registerDevice "$device" >/dev/null

set="$(defer "$WHAT" remind "$CHAT" "Remind me in a minute to send the Lumen mockups")"
expect_in "$set" "kin_defer: ok" "Zoya couldn't set her own reminder"
ITEM="$(item_of "$set")"
expect_in "$(defer "Proof o$RUN: ping Rhea" remind "$OWNER_CHAT" "Remind Rhea in a minute")" "refused" \
  "Zoya's turn set a reminder in the owner's chat"
expect_in "$(defer "Proof s$RUN: start the mockups" start "$CHAT" "Start the mockups in a minute")" "refused" \
  "Zoya's turn set a reminder that starts work"

# Her own: moved by her next turn, and cancelled by another. These are due in an hour, so only
# the first comes due here.
LATER="$(at 3600)"
moving="$(item_of "$(defer "Proof v$RUN: call the printer" remind "$CHAT" "Remind me to call the printer")")"
moved="$(defer "Proof v$RUN: call the printer, later" remind "$CHAT" "Make that later" "$moving")"
expect_in "$moved" "kin_defer: ok" "Zoya couldn't move her own reminder"
wait_state "$moving" disarmed "moving Zoya's reminder left the old one armed"
gone="$(item_of "$(defer "Proof c$RUN: book the van" remind "$CHAT" "Remind me to book the van")")"
expect_in "$(cancel "$gone" "Never mind the van")" "kin_cancel: ok" "Zoya couldn't cancel her own reminder"
wait_state "$gone" disarmed "Zoya's cancel left her reminder armed"
# The owner's: her turn can neither move nor cancel it.
owners="$(item_of "$(defer "Proof r$RUN: Rhea's call" remind "$OWNER_CHAT" "Remind me about my call" "" owner)")"
[[ -n "$owners" ]] || fail "the owner couldn't set his own reminder"
expect_in "$(defer "Proof r$RUN: Rhea's call, later" remind "$CHAT" "Move Rhea's call" "$owners")" "not_allowed" \
  "Zoya's turn moved the owner's reminder"
expect_in "$(cancel "$owners" "Cancel Rhea's call")" "not_allowed" "Zoya's turn cancelled the owner's reminder"
[[ "$(run_state "$owners")" == armed ]] || fail "the owner's reminder isn't armed after Zoya's turns"

# Before it is due there is no card: a remind posts none (the agent's reply says when), so she
# moves or cancels it by asking, as above. Undo and Cancel are on start and chase cards only.
unset LATER

for _ in $(seq 1 120); do
  [[ "$(q "select count(*) from kin_messages where body like 'Reminder: $WHAT%'")" == 1 ]] && break
  sleep 1
done
[[ "$(q "select count(*) from kin_messages where body like 'Reminder: $WHAT%' and chat_id = '$CHAT'")" == 1 ]] ||
  fail "the reminder never came due in Zoya's chat"
[[ "$(q "select count(*) from kin_messages where chat_id = '$OWNER_CHAT' and body like '%$RUN%' and body not like '%Rhea''s call%'")" == 0 ]] ||
  fail "Zoya's reminder reached the owner's chat"
sleep 2
expect_in "$(kv push sent | rg "/eeeeee" | rg -F "Reminder: $WHAT" || true)" "Reminder:" "Zoya's phone didn't ring for it"

# Due, her card offers every tap, and each one works for her.
kv as zoya web open chat:chief >/dev/null
card="$(kv as zoya web snapshot --full)"
for name in "Change this with your agent" "Snooze this reminder for 10 minutes" \
  "Snooze this reminder for an hour" "Snooze this reminder to tomorrow at 9:00" "Mark this reminder done"; do
  expect_in "$card" "$name" "Zoya's due reminder has no \"$name\""
done
kv as zoya web click --name "Snooze this reminder for 10 minutes" --within "$WHAT" >/dev/null
wait_state "$ITEM" snoozed "Zoya's Snooze didn't snooze her reminder"
snoozed_until() { q "select json_extract(snapshot_json, '\$.snoozedUntil') from kin_deferral_runs where item_id = '$ITEM'"; }
soon="$(snoozed_until)"
kv as zoya web click --name "Snooze this reminder to tomorrow at 9:00" --within "$WHAT" >/dev/null || fail "no Tomorrow 9:00 after a snooze"
for _ in $(seq 1 15); do
  [[ "$(snoozed_until)" != "$soon" ]] && break
  sleep 1
done
# Tomorrow at 9:00 is at least nine hours past a ten-minute snooze.
(($(snoozed_until) > soon + 8 * 3600000)) || fail "Zoya's Tomorrow 9:00 didn't move her reminder ($soon to $(snoozed_until))"
kv as zoya web click --name "Change this with your agent" --within "$WHAT" >/dev/null || fail "Zoya has no Change on her reminder"
for _ in $(seq 1 15); do
  [[ "$(q "select count(*) from kin_messages where chat_id = '$CHAT' and kind = 'widget_action' and body like '%\"change\"%'")" -ge 1 ]] && break
  sleep 1
done
[[ "$(q "select count(*) from kin_messages where chat_id = '$CHAT' and kind = 'widget_action' and body like '%\"change\"%'")" -ge 1 ]] ||
  fail "Zoya's Change didn't reach her agent"
kv as zoya web click --name "Mark this reminder done" --within "$WHAT" >/dev/null || fail "Zoya has no Done on her reminder"
wait_state "$ITEM" done "Zoya's Done didn't finish her reminder"
pass "Zoya set her own reminder and nothing for anyone else; moved and cancelled her own, not the owner's; it came due in her chat, rang her phone, and her Snooze, Tomorrow 9:00, Change and Done each worked"
