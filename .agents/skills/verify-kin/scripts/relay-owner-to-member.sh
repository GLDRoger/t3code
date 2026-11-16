#!/usr/bin/env bash
# In the owner's turn, Chief of staff relays a message to Zoya (kin_relay); it appears in Zoya's chat.
source "$(dirname "$0")/lib.sh"
TEXT="Proof $RUN: can W-3 move to 18 December? The clinic asked for more time."
OUT="$(kv tool chief kin_relay "{\"to\":\"Zoya Sheikh\",\"text\":\"$TEXT\"}" --as-turn-of owner)"
expect_in "$OUT" "kin_relay: ok" "kin_relay was refused: $OUT"
kv as zoya web open chat:chief >/dev/null
kv as zoya web wait "$TEXT" >/dev/null || fail "the relay never showed in Zoya's chat"
expect_not_in "$(kv as arjun web open chat:chief >/dev/null; kv as arjun web snapshot)" "$TEXT" "the relay showed in Arjun's chat"
pass "the owner's message reached Zoya's chat, and only hers"
