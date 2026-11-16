#!/usr/bin/env bash
# Arjun, with Clients off, opening a client is told it isn't his to see, never a connection problem, and is offered no Retry.
source "$(dirname "$0")/lib.sh"
ARJUN="$(kv people | awk '$1 == "arjun" { print $NF }')"
had="$(kv db "select sees_clients from kin_people where person_id = '$ARJUN'" | tail -1)"
restore() { kv as owner rpc kin.people.setPlaces "{\"personId\":\"$ARJUN\",\"clients\":$([[ $had == 1 ]] && echo true || echo false)}" >/dev/null; }
trap restore EXIT
kv as owner rpc kin.people.setPlaces "{\"personId\":\"$ARJUN\",\"clients\":false}" >/dev/null
kv as arjun web open "clients?client=C-2" >/dev/null
kv as arjun web wait "This client isn't yours to see" >/dev/null || fail "Arjun's refusal doesn't say it isn't his"
seen="$(kv as arjun web snapshot --full)"
expect_not_in "$seen" "Couldn't load" "a refusal reads as a load failure"
expect_not_in "$seen" "Check your connection" "a refusal reads as a connection problem"
expect_not_in "$seen" "Retry" "a refusal offers Retry"
expect_not_in "$seen" "Orbit Dental" "the refusal names the client"
pass "Arjun, Clients off, opening C-2 is told it isn't his to see, with no Retry"
