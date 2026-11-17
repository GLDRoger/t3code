#!/usr/bin/env bash
# Zoya has Money open while the owner switches her Money place on, then off: the open page follows each way without her navigating.
source "$(dirname "$0")/lib.sh"
ZOYA="$(kv people | awk '$1 == "zoya" { print $NF }')"
had="$(kv db "select sees_money from kin_people where person_id = '$ZOYA'" | tail -1)"
place() { kv as owner rpc kin.people.setPlaces "{\"personId\":\"$ZOYA\",\"money\":$1}" >/dev/null; }
trap 'place "$([[ $had == 1 ]] && echo true || echo false)"' EXIT
place false
kv as zoya web open money >/dev/null
kv as zoya web wait "Not available" >/dev/null || fail "Zoya, Money off, isn't told Money isn't hers"
place true
kv as zoya web wait "Owed to us" >/dev/null || fail "Zoya's open Money page stays refused after the owner switched it on"
place false
kv as zoya web wait "Not available" >/dev/null || fail "Zoya's open Money page keeps its figures after the owner switched it off"
pass "Zoya's open Money page follows the owner's switch on and off without navigating"
