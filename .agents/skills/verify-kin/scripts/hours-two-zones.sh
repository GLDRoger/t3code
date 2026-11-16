#!/usr/bin/env bash
# Each person's hours, on their own clock. Zoya works 10:00 to 18:00 and it is 20:00 where she
# is; Arjun works the same hours and it is 12:00 where he is. The owner's relay reaches Arjun now;
# Zoya's waits, the agent is told until when in her time, and her phone stays quiet. Switching
# "Hold non-urgent messages outside my working hours" off lets the next one through; at 10:00 her
# time the held one lands, once.
source "$(dirname "$0")/lib.sh"
zone_at() { node -e 'const h=new Date().getUTCHours();let n=((+process.argv[1]-h)%24+24)%24;if(n>14)n-=24;process.stdout.write(n===0?"Etc/GMT":`Etc/GMT${n>0?"-":"+"}${Math.abs(n)}`)' "$1"; }
q() { kv db "$1" | tail -n +2 | tail -1; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
ARJUN="$(q "select person_id from kin_people where display_name = 'Arjun Rao'")"
HOURS='{"days":[0,1,2,3,4,5,6],"start":"10:00","end":"18:00"}'
# A line to someone who wrote in that chat in the last 10 minutes answers them and never waits.
kv clock advance 11m >/dev/null
EVENING="$(zone_at 20)"
NOON="$(zone_at 12)"
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"$EVENING\",\"workHours\":$HOURS}" >/dev/null
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ARJUN\",\"timeZone\":\"$NOON\",\"workHours\":$HOURS}" >/dev/null
# Only she sets her switch: the owner can't.
refused="$(kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"holdOutsideHours\":false}" 2>&1 || true)"
expect_in "$refused" "Only they can set" "the owner switched Zoya's holding off for her"
kv as zoya rpc kin.push.registerDevice "{\"token\":\"$(printf 'b%.0s' {1..64})\",\"platform\":\"ios\",\"apsEnvironment\":\"development\"}" >/dev/null
pushes() { kv push sent | rg -c "/bbbbbb" || echo 0; }
before="$(pushes)"

TO_ARJUN="Proof h$RUN: the deck review is at 15:00."
out="$(kv tool chief kin_relay "{\"to\":\"Arjun Rao\",\"text\":\"$TO_ARJUN\"}" --as-turn-of owner)"
expect_in "$out" "kin_relay: ok" "the relay to Arjun was refused: $out"
[[ "$(q "select count(*) from kin_messages where body = '$TO_ARJUN'")" == 1 ]] ||
  fail "the relay to Arjun, in his working hours, didn't land now"

TO_ZOYA="Proof z$RUN: the clinic sent new photos for the shortlist."
out="$(kv tool chief kin_relay "{\"to\":\"Zoya Sheikh\",\"text\":\"$TO_ZOYA\"}" --as-turn-of owner)"
expect_in "$out" "kin_relay: ok" "the relay to Zoya was refused: $out"
expect_in "$out" "off until 10:00 their time" "the agent wasn't told when Zoya gets it"
[[ "$(q "select count(*) from kin_messages where body = '$TO_ZOYA'")" == 0 ]] ||
  fail "the relay reached Zoya outside her working hours"
[[ "$(pushes)" == "$before" ]] || fail "the held relay pushed Zoya's phone"

# Her switch off: the next one goes through at once.
kv as zoya rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"holdOutsideHours\":false}" >/dev/null
NOW_ZOYA="Proof n$RUN: the shortlist call moved to Friday."
kv tool chief kin_relay "{\"to\":\"Zoya Sheikh\",\"text\":\"$NOW_ZOYA\"}" --as-turn-of owner >/dev/null
[[ "$(q "select count(*) from kin_messages where body = '$NOW_ZOYA'")" == 1 ]] ||
  fail "with her switch off, the relay still waited"
kv as zoya rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"holdOutsideHours\":true}" >/dev/null

# 10:00 her time: what waited lands, once.
due="$(q "select deliver_at from kin_held_posts where body like '%$TO_ZOYA%' and delivered_at is null")"
[[ -n "$due" ]] || fail "nothing of Zoya's waits"
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"$(zone_at 11)\"}" >/dev/null
kv clock advance "$(((due - $(date +%s) * 1000) / 60000 + 2))m" >/dev/null
for _ in $(seq 1 90); do
  [[ "$(q "select count(*) from kin_messages where body = '$TO_ZOYA'")" == 1 ]] && break
  sleep 1
done
[[ "$(q "select count(*) from kin_messages where body = '$TO_ZOYA'")" == 1 ]] ||
  fail "the held relay isn't in Zoya's chat once at the start of her day"
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"Asia/Kolkata\",\"workHours\":{\"days\":[0,1,2,3,4,5,6],\"start\":\"00:00\",\"end\":\"23:59\"}}" >/dev/null
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ARJUN\",\"timeZone\":\"Asia/Kolkata\",\"workHours\":{\"days\":[0,1,2,3,4,5,6],\"start\":\"00:00\",\"end\":\"23:59\"}}" >/dev/null
pass "Arjun at 12:00 his time got it now; Zoya at 20:00 hers waited until 10:00 her time, silent, and her switch off let one through"
