#!/usr/bin/env bash
# Arjun, without Clients, opening a client says it isn't his to see, never a connection problem, and names nothing.
source "$(dirname "$0")/lib.sh"
kv as arjun web open "clients?client=C-1" >/dev/null
kv as arjun web wait "This client isn't yours to see" >/dev/null || fail "Arjun's refusal doesn't say it isn't his"
seen="$(kv as arjun web snapshot --full)"
expect_not_in "$seen" "Couldn't load" "a refusal reads as a load failure"
expect_not_in "$seen" "Check your connection" "a refusal reads as a connection problem"
expect_not_in "$seen" "Retry" "a refusal offers Retry"
pass "Arjun opening C-1 is told it isn't his to see, with no Retry"
