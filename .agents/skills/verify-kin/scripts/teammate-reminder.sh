#!/usr/bin/env bash
# Zoya asks Chief of staff to remind her: it is set, comes due in her own chat (not the owner's),
# rings her phone, and she taps Done herself. A reminder for someone else, or one that starts
# work, is refused on her turn. Waits about a minute of real time: stored reminders keep their own
# due time, so `kv clock advance` would leave them stale.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
CHIEF="$(q "select agent_id from kin_leads where domain = 'chief' limit 1")"
CHAT="$(q "select chat_id from kin_chats where direct_key = '$ZOYA:$CHIEF'")"
OWNER_CHAT="$(q "select owner_chat_id from kin_leads where agent_id = '$CHIEF'")"
WHAT="Proof m$RUN: send the Lumen mockups"
DUE="$(node -e 'process.stdout.write(new Date(Date.now()+60*1000).toISOString().replace("Z","+00:00"))')"
defer() { kv tool chief kin_defer "{\"what\":\"$1\",\"due\":\"$DUE\",\"onDue\":\"$2\",\"chatId\":\"$3\",\"sourceEventId\":\"\$event\"}" --as-turn-of zoya --say "$4" 2>&1; }
kv as zoya rpc kin.push.registerDevice "{\"token\":\"$(printf 'd%.0s' {1..64})\",\"platform\":\"ios\",\"apsEnvironment\":\"development\"}" >/dev/null

set="$(defer "$WHAT" remind "$CHAT" "Remind me in a minute to send the Lumen mockups")"
expect_in "$set" "kin_defer: ok" "Zoya couldn't set her own reminder"
ITEM="$(rg -o 'def-[0-9a-f]+' <<<"$set" | head -1)"
expect_in "$(defer "Proof o$RUN: ping Rhea" remind "$OWNER_CHAT" "Remind Rhea in a minute")" "refused" \
  "Zoya's turn set a reminder in the owner's chat"
expect_in "$(defer "Proof s$RUN: start the mockups" start "$CHAT" "Start the mockups in a minute")" "refused" \
  "Zoya's turn set a reminder that starts work"

for _ in $(seq 1 120); do
  [[ "$(q "select count(*) from kin_messages where body like 'Reminder: $WHAT%'")" == 1 ]] && break
  sleep 1
done
[[ "$(q "select count(*) from kin_messages where body like 'Reminder: $WHAT%' and chat_id = '$CHAT'")" == 1 ]] ||
  fail "the reminder never came due in Zoya's chat"
[[ "$(q "select count(*) from kin_messages where chat_id = '$OWNER_CHAT' and body like '%$RUN%'")" == 0 ]] ||
  fail "Zoya's reminder reached the owner's chat"
sleep 2
expect_in "$(kv push sent | rg "/dddddd" | rg -F "Reminder: $WHAT" || true)" "Reminder:" "Zoya's phone didn't ring for it"

kv as zoya web open chat:chief >/dev/null
kv as zoya web click --name "Mark this reminder done" >/dev/null || fail "Zoya has no Done on her reminder"
for _ in $(seq 1 15); do
  [[ "$(q "select state from kin_deferral_runs where item_id = '$ITEM'")" == done ]] && break
  sleep 1
done
[[ "$(q "select state from kin_deferral_runs where item_id = '$ITEM'")" == done ]] ||
  fail "Zoya's Done didn't finish her reminder"
pass "Zoya set her own reminder and nothing for anyone else; it came due in her chat, rang her phone, and her Done finished it"
