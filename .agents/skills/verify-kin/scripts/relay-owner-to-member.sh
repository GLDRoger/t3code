#!/usr/bin/env bash
# In the owner's turn, Chief of staff relays a message to Zoya (kin_relay); it appears in Zoya's
# chat with the task's key written as its name.
source "$(dirname "$0")/lib.sh"
TITLE="$(kv db "select title from kin_records where key = 'W-3'" | tail -1)"
TEXT="Proof r$RUN: can W-3 move to 18 December? The clinic asked for more time."
SHOWN="Proof r$RUN: can $TITLE move to 18 December? The clinic asked for more time."
OUT="$(kv tool chief kin_relay "{\"to\":\"Zoya Sheikh\",\"text\":\"$TEXT\"}" --as-turn-of owner)"
expect_in "$OUT" "kin_relay: ok" "kin_relay was refused: $OUT"
kv as zoya web open chat:chief >/dev/null
kv as zoya web wait "$SHOWN" >/dev/null || fail "the relay never showed in Zoya's chat as \"$SHOWN\""
expect_not_in "$(kv as arjun web open chat:chief >/dev/null; kv as arjun web snapshot)" "Proof r$RUN" "the relay showed in Arjun's chat"
pass "the owner's message reached Zoya's chat, and only hers, with W-3 named \"$TITLE\""
