#!/usr/bin/env bash
# The owner asks Chief of staff to ask Zoya something in a minute. When it comes due, the Chief is
# woken with it to ask her itself: the run is started, a deferral.due waits for the Chief, and no
# card lands in the owner's chat. A promise to ask the owner himself still comes back as his card.
# Waits about a minute of real time: a deferral keeps its own due time, so `kv clock advance`
# would leave it stale. Needs kin_defer to name who is asked (`ask`, stored as the item's owner).
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
CHIEF="$(q "select agent_id from kin_leads where domain = 'chief' limit 1")"
OWNER_CHAT="$(q "select owner_chat_id from kin_leads where agent_id = '$CHIEF'")"
at() { node -e 'process.stdout.write(new Date(Date.now()+(+process.argv[1])*1000).toISOString().replace("Z","+00:00"))' "$1"; }
DUE="$(at 60)"
# defer <what> <who> <say>
defer() {
  local input="{\"what\":\"$1\",\"due\":\"$DUE\",\"onDue\":\"ask\",\"ask\":\"$2\",\"chatId\":\"$OWNER_CHAT\",\"sourceEventId\":\"\$event\"}"
  kv tool chief kin_defer "$input" --as-turn-of owner --say "$3" 2>&1
}
item_of() { rg -o 'def-[0-9a-f]+' <<<"$1" | head -1; }
run_state() { q "select state from kin_deferral_runs where item_id = '$1'"; }

zoya="$(defer "Proof z$RUN: ask Zoya whether the clinic signed off the poster" "Zoya Sheikh" "Ask Zoya in a minute whether the clinic signed off")"
expect_in "$zoya" "kin_defer: ok" "kin_defer couldn't name Zoya as the one to ask"
ZOYA_ITEM="$(item_of "$zoya")"
me="$(defer "Proof m$RUN: ask me about the van" "Rhea Kapoor" "Ask me in a minute about the van")"
expect_in "$me" "kin_defer: ok" "the owner couldn't set a promise to ask himself"
ME_ITEM="$(item_of "$me")"

for _ in $(seq 1 120); do
  [[ "$(run_state "$ZOYA_ITEM")" == started && "$(run_state "$ME_ITEM")" == asked ]] && break
  sleep 1
done
[[ "$(run_state "$ZOYA_ITEM")" == started ]] || fail "the promise to ask Zoya wasn't handed to the Chief (state $(run_state "$ZOYA_ITEM"))"
[[ "$(q "select count(*) from kin_events where agent_id = '$CHIEF' and tag = 'deferral.due' and json_extract(json, '\$.subject.itemId') = '$ZOYA_ITEM'")" == 1 ]] ||
  fail "the Chief wasn't woken once with the promise to ask Zoya"
[[ "$(q "select count(*) from kin_widgets where widget_id like 'deferral:%:$ZOYA_ITEM' and json_extract(state_json, '\$.phase') = 'asked'")" == 0 ]] ||
  fail "the promise to ask Zoya came back to the owner as a card"
[[ "$(run_state "$ME_ITEM")" == asked ]] || fail "the promise to ask the owner didn't come due (state $(run_state "$ME_ITEM"))"
[[ "$(q "select count(*) from kin_widgets where widget_id like 'deferral:%:$ME_ITEM' and chat_id = '$OWNER_CHAT' and json_extract(state_json, '\$.phase') = 'asked'")" == 1 ]] ||
  fail "the promise to ask the owner didn't come back as his card"
pass "a promise to ask Zoya woke the Chief once to ask her, with no card for the owner; a promise to ask the owner came back as his card"
