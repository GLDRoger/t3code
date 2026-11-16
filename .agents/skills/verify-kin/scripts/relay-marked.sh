#!/usr/bin/env bash
# A relay reads as the person's, carried by the agent: Rhea's question in Zoya's chat says
# "Sent by Rhea Kapoor" with "via Chief of staff", and Zoya's phone shows "Rhea, via Chief of
# staff". Zoya's answer comes back to Rhea the same way.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
zone_at() { node -e 'const h=new Date().getUTCHours();let n=((+process.argv[1]-h)%24+24)%24;if(n>14)n-=24;process.stdout.write(n===0?"Etc/GMT":`Etc/GMT${n>0?"-":"+"}${Math.abs(n)}`)' "$1"; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
# Midday for both, so neither's quiet hours silence what this checks.
COMPANY="$(q "select time_zone from kin_trigger_settings limit 1")"
NOON="$(zone_at 12)"
kv as owner rpc kin.triggers.setTimeZone "{\"timeZone\":\"$NOON\"}" >/dev/null
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"$NOON\"}" >/dev/null
kv as zoya rpc kin.push.registerDevice "{\"token\":\"$(printf 'c%.0s' {1..64})\",\"platform\":\"ios\",\"apsEnvironment\":\"development\"}" >/dev/null
kv as owner rpc kin.push.registerDevice "{\"token\":\"$(printf 'd%.0s' {1..64})\",\"platform\":\"ios\",\"apsEnvironment\":\"development\"}" >/dev/null

ASK="Proof m$RUN: can you send the clinic photos by Thursday?"
out="$(kv tool chief kin_relay "{\"to\":\"Zoya Sheikh\",\"text\":\"$ASK\"}" --as-turn-of owner)"
expect_in "$out" "kin_relay: ok" "the relay was refused: $out"
relay="$(q "select relay_json from kin_messages where body = '$ASK'")"
expect_in "$relay" '"personId":"kin-default-owner"' "the relay doesn't say Rhea sent it: $relay"
kv as zoya web open chat:chief >/dev/null
kv as zoya web wait "$ASK" >/dev/null || fail "the relay never showed in Zoya's chat"
seen="$(kv as zoya web snapshot)"
expect_in "$seen" "Sent by Rhea Kapoor" "Zoya's chat doesn't say Rhea sent it"
expect_in "$seen" "via Chief of staff" "Zoya's chat doesn't say the agent carried it"
for _ in $(seq 1 20); do contains "$(kv push sent)" "Rhea, via Chief of staff: Proof m$RUN" && break; sleep 1; done
expect_in "$(kv push sent)" "Rhea, via Chief of staff: Proof m$RUN" "Zoya's push doesn't name Rhea"

ANSWER="Proof a$RUN: yes, the photos go out Wednesday."
out="$(kv tool chief kin_relay "{\"to\":\"Rhea Kapoor\",\"text\":\"$ANSWER\"}" --as-turn-of zoya --say "Tell Rhea the photos go out Wednesday.")"
expect_in "$out" "kin_relay: ok" "Zoya's answer was refused: $out"
back="$(q "select relay_json from kin_messages where body like '%$ANSWER%' and author_kind = 'agent'")"
expect_in "$back" "\"personId\":\"$ZOYA\"" "the answer in Rhea's chat doesn't say Zoya sent it: $back"
kv as owner web open chat:chief >/dev/null
kv as owner web wait "$ANSWER" >/dev/null || fail "Zoya's answer never showed in Rhea's chat"
expect_in "$(kv as owner web snapshot)" "Sent by Zoya Sheikh" "Rhea's chat doesn't say Zoya sent it"
for _ in $(seq 1 20); do contains "$(kv push sent)" "Zoya, via Chief of staff" && break; sleep 1; done
expect_in "$(kv push sent)" "Zoya, via Chief of staff" "Rhea's push doesn't name Zoya"
kv as owner rpc kin.triggers.setTimeZone "{\"timeZone\":\"${COMPANY:-Asia/Kolkata}\"}" >/dev/null
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"Asia/Kolkata\"}" >/dev/null
pass "Rhea's question reads as hers in Zoya's chat and push, and Zoya's answer as hers in Rhea's"
