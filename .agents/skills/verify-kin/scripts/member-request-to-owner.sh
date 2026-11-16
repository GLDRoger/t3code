#!/usr/bin/env bash
# In Zoya's turn, Chief of staff carries her request to the owner (kin_relay); it waits in the owner's chat.
source "$(dirname "$0")/lib.sh"
TITLE="$(kv db "select title from kin_records where key = 'W-3'" | tail -1)"
TEXT="Proof $RUN: I'm on leave 7 to 12 December. Can W-3 move, or go to someone else?"
SHOWN="Proof $RUN: I'm on leave 7 to 12 December. Can $TITLE move, or go to someone else?"
OUT="$(kv tool chief kin_relay "{\"to\":\"Rhea Kapoor\",\"text\":\"$TEXT\"}" --as-turn-of zoya)"
expect_in "$OUT" "kin_relay: ok" "kin_relay from Zoya's chat was refused: $OUT"
kv as owner web open chat:chief >/dev/null
kv as owner web wait "$SHOWN" >/dev/null || fail "Zoya's request never showed in the owner's chat"
# This run's message, named as hers (earlier runs' lines stay in the same chat).
line="$(kv as owner web snapshot | grep -F "Proof $RUN:" | head -1)"
expect_in "$line" "Sent by Zoya Sheikh, via Chief of staff" "the owner's chat doesn't say who asked: $line"
pass "Zoya's request reached the owner's chat, quoted as hers"
