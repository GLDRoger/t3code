#!/usr/bin/env bash
# The owner answers Chief of staff's choice card. Later he searches a word from it, finds the
# decision memory saved, and opens it in Settings → Memory. Zoya, a member, searches the same
# word and finds nothing, over RPC and on her screen.
source "$(dirname "$0")/lib.sh"
WORD="courier$RUN"
QUESTION="Which $WORD do we use for the Lumen samples?"
search_as() { kv as "$1" rpc kin.search "{\"text\":\"$WORD\",\"everything\":true}"; }

out="$(kv tool chief kin_ask "{\"question\":\"$QUESTION\",\"detail\":\"Bluedart is a day faster; DTDC is ₹40 cheaper a parcel.\",\"options\":[{\"label\":\"Bluedart\"},{\"label\":\"DTDC\"}],\"default\":\"none\",\"intent\":\"book the samples courier\"}" \
  --say "how do we send the Lumen samples?" --reply "One question for you.")"
expect_in "$out" "kin_ask: ok" "Chief of staff's ask was refused: $out"
expect_not_in "$(search_as owner)" '"memory"' "a decision was found before anyone answered"

# The owner answers on the card in his chat.
kv as owner web open chat:chief >/dev/null
kv as owner web wait "$QUESTION" >/dev/null || fail "the card never reached the owner's chat"
kv as owner web click --name "Bluedart" >/dev/null

# Memory saves it once the tap commits; it is a git commit, so give it a moment.
found=""
for _ in $(seq 1 40); do
  found="$(search_as owner)"
  contains "$found" '"memory"' && break
  sleep 2
done
expect_in "$found" '"kind":"memory"' "the owner's search doesn't find the decision"
expect_in "$found" "$QUESTION" "the decision isn't titled with the card's question"
expect_in "$found" "Chose “Bluedart” over “DTDC”" "the decision doesn't say what was chosen"
[[ "$(kv db "select count(*) from kin_widgets where state_json like '%$WORD%'" | tail -1)" == 1 ]] ||
  fail "the card was posted more than once"

# On his screen: Search finds it as remembered, and it opens in Settings → Memory.
kv as owner web open tasks >/dev/null
kv as owner web click --name "Search" >/dev/null
kv as owner web type --name "Search tasks, clients, docs and money" "$WORD" >/dev/null
kv as owner web wait "Remembered" >/dev/null || fail "the owner's search box shows no remembered hit"
kv as owner web click --name "$QUESTION" >/dev/null
kv as owner web wait "Memory" >/dev/null || fail "the hit didn't open Settings → Memory"
expect_in "$(kv as owner web snapshot --full)" "$QUESTION" "Settings → Memory doesn't list the decision"

# Zoya, a member, finds nothing of it: not over RPC, not in her search box.
expect_not_in "$(search_as zoya)" '"memory"' "Zoya's search reads memory"
expect_not_in "$(search_as zoya)" "$WORD" "Zoya's search finds the owner's decision"
kv as zoya web open tasks >/dev/null
kv as zoya web click --name "Search" >/dev/null
kv as zoya web type --name "Search tasks, clients, docs and money" "$WORD" >/dev/null
kv as zoya web wait "Nothing you can see matches" >/dev/null || fail "Zoya's search box didn't settle on nothing"
expect_not_in "$(kv as zoya web snapshot)" "$QUESTION" "Zoya's search box shows the decision"

pass "the owner's answer is found again by a word from it and opens in Memory; Zoya finds nothing"
