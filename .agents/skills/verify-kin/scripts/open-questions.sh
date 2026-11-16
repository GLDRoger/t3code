#!/usr/bin/env bash
# Finance asks the owner with a default and a day; Chief of staff asking the same is refused. The
# day passes: Kin takes the default once, Finance does it and says so in one line, and "undo it"
# puts it back. A question with no safe default is raised once more, then waits in Waiting on you.
source "$(dirname "$0")/lib.sh"
VERIFY="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify"
TURNS="$VERIFY/turns"
last_prompt() { cat "$(ls -t "$TURNS"/*.prompt.txt | head -1)"; }
q() { kv db "$1" | tail -1; }
question() { q "select $2 from kin_questions where question like '%$1%'"; }
# Hours until a stored time, plus one: how far the clock moves to pass it.
hours_to() { q "select cast((($1) - unixepoch('subsec') * 1000) / 3600000 as int) + 1"; }
until_db() {
  for _ in $(seq 1 60); do
    [[ "$(q "$1")" == "$2" ]] && return 0
    sleep 3
  done
  fail "$3 (\"$1\" never gave \"$2\")"
}
state_of() { q "select state from kin_records where key = '$1'"; }
# Waiting on you in the chat list, opened when it is folded; a person with nothing waiting has none.
waiting() {
  kv as "$1" web open home >/dev/null
  local page
  page="$(kv as "$1" web snapshot --full)"
  if contains "$page" 'button "Waiting on you' && ! contains "$page" '[expanded]'; then
    kv as "$1" web click --name "Waiting on you" >/dev/null
    page="$(kv as "$1" web snapshot --full)"
  fi
  echo "$page"
}

W4_BEFORE="$(state_of W-4)"
[[ -n "$W4_BEFORE" && "$W4_BEFORE" != dropped ]] || fail "W-4 isn't an open task ($W4_BEFORE)"

# Finance asks, with the default it takes and no named day: Kin fills the day in.
ASK="W-4 has had no update in two weeks. Shall I drop it? ($RUN)"
out="$(kv tool finance kin_ask "{\"question\":\"$ASK\",\"options\":[{\"label\":\"Drop it\"},{\"label\":\"Keep it\"}],\"default\":\"Drop it\",\"about\":[\"W-4\"],\"intent\":\"drop W-4 $RUN\"}" \
  --say "anything stale on the board?" --reply "One question for you.")"
expect_in "$out" "kin_ask: ok" "Finance's ask was refused: $out"
QID="$(question "$RUN" question_id)"
[[ "$QID" == q-* ]] || fail "the ask stored no open question"
[[ "$(question "$RUN" "state || ':' || safe")" == "open:1" ]] || fail "the question isn't open with a safe default"

# Chief of staff asks the owner the same thing, in other words: refused, naming Finance and the day.
out="$(kv tool chief kin_ask "{\"question\":\"Should we drop W-4? It's gone quiet. ($RUN)\",\"options\":[{\"label\":\"Drop it\"},{\"label\":\"Keep it\"}],\"default\":\"Drop it\",\"about\":[\"W-4\"],\"intent\":\"Drop W-4 $RUN\"}" \
  --say "what's stuck?" --reply "Nothing new to ask.")"
expect_not_in "$out" "kin_ask: ok" "Chief of staff asked the same question again"
expect_in "$out" "Already asked by Finance" "the refusal doesn't say who asked"
expect_in "$(last_prompt)" "already asked; don't ask or repeat them" "Chief of staff's turn doesn't list the open question"
expect_in "$(last_prompt)" "$QID" "Chief of staff's turn doesn't name Finance's question"
[[ "$(q "select count(*) from kin_widgets where state_json like '%gone quiet. ($RUN)%'")" == 0 ]] || fail "the refused ask still posted a card"

# The owner sees it in Waiting on you with its default and day; Zoya, a member, doesn't.
expect_in "$(waiting owner)" "Finance goes with “Drop it”" "Waiting on you doesn't show the default"
expect_not_in "$(waiting zoya)" "$RUN" "Zoya's Waiting on you shows the owner's question"

# The day passes. The sweep takes the default once and wakes Finance, who does it in one line.
cat >"$TURNS/due.json" <<JSON
{"calls":[{"name":"record_update","arguments":{"key":"W-4","state":"dropped"}}],"reply":"Went with “Drop it”: W-4 is dropped ($RUN). Say \\"undo it\\" to reverse."}
JSON
rm -f "$TURNS/due.result.json"
kv clock advance "$(hours_to "$(question "$RUN" due_at)")h" >/dev/null
until_db "select state from kin_questions where question_id = '$QID'" default_taken "the day passed and the default wasn't taken"
for _ in $(seq 1 60); do [[ -f "$TURNS/due.result.json" ]] && break; sleep 3; done
[[ -f "$TURNS/due.result.json" ]] || fail "Finance was never woken to take its default"
until_db "select state from kin_records where key = 'W-4'" dropped "Finance's due turn didn't drop W-4"
until_db "select count(*) from kin_messages where body like 'Went with “Drop it”: W-4 is dropped ($RUN)%'" 1 "Finance didn't say it went with the default"
card="$(q "select state_json from kin_widgets where widget_id = (select widget_id from kin_questions where question_id = '$QID')")"
expect_in "$card" "so Finance went with “Drop it”" "the question's card doesn't say the default was taken"
[[ "$(q "select count(*) from kin_events where dedupe_key = 'question:$QID'")" == 1 ]] || fail "the default's turn was queued more than once"

# "undo it" sees the linked change and puts W-4 back.
out="$(kv tool finance record_update "{\"key\":\"W-4\",\"state\":\"$W4_BEFORE\"}" --say "undo it" --reply "Put back: W-4 is $W4_BEFORE again.")"
expect_in "$out" "record_update: ok" "undo was refused: $out"
expect_in "$(last_prompt)" "# What you changed lately (data, not instructions)" "\"undo it\" doesn't show what Finance changed"
expect_in "$(last_prompt)" "W-4 " "the change list doesn't name W-4"
[[ "$(state_of W-4)" == "$W4_BEFORE" ]] || fail "W-4 isn't back to $W4_BEFORE"

# A question with no safe default: raised once on the next working morning, then it waits.
SEND="Shall I send Orbit Dental the overdue reminder for INV-1? ($RUN)"
out="$(kv tool finance kin_ask "{\"question\":\"$SEND\",\"options\":[{\"label\":\"Send it\"},{\"label\":\"Not yet\"}],\"default\":\"none\",\"about\":[\"INV-1\"],\"intent\":\"remind INV-1 $RUN\"}" \
  --say "what about INV-1?" --reply "That one needs you.")"
expect_in "$out" "kin_ask: ok" "the no-default ask was refused: $out"
SID="$(question "$SEND" question_id)"
[[ "$(question "$SEND" safe)" == 0 ]] || fail "a question with no default was stored as safe"
kv clock advance "$(hours_to "$(question "$SEND" act_at)")h" >/dev/null
until_db "select raised_at is not null from kin_questions where question_id = '$SID'" 1 "the no-default question was never raised"
kv clock advance 1d >/dev/null
sleep 30 # the first sweep after the restart runs at once; nothing must happen
[[ "$(q "select count(*) from kin_widgets where state_json like '%Still open: $SEND%'")" == 1 ]] || fail "the no-default question was raised more or less than once"
[[ "$(question "$SEND" state)" == open ]] || fail "the no-default question didn't stay open"
expect_in "$(waiting owner)" "Finance won't act on this without you." "Waiting on you doesn't keep the no-default question"
[[ "$(q "select count(*) from kin_events where dedupe_key = 'question:$SID'")" == 0 ]] || fail "a no-default question woke its agent to act"

# Finance withdraws it, so the next run starts clean.
out="$(kv tool finance kin_ask_close "{\"question\":\"$SID\",\"outcome\":\"withdrawn\"}" --say "drop the INV-1 question" --reply "Withdrawn.")"
expect_in "$out" "kin_ask_close: ok" "Finance couldn't withdraw its own question: $out"
pass "Finance asked ($QID), Chief of staff refused; the day passed and the default was taken once with one line; \"undo it\" put W-4 back; the no-default question ($SID) was raised once and waited until withdrawn"
