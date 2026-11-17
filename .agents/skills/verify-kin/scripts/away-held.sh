#!/usr/bin/env bash
# Away until a day. The owner marks Zoya away; Arjun can't. The owner's relay to her waits, with a
# line in the owner's chat saying when it arrives. Her "I'm back" lets the held one through, once.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
BACK="$(TZ=Asia/Kolkata node -e 'const d=new Date(Date.now()+3*864e5);process.stdout.write(d.toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"}))')"
kv clock advance 11m >/dev/null

refused="$(kv as arjun rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"awayUntil\":\"$BACK\"}" 2>&1 || true)"
expect_not_in "$(q "select coalesce(away_until, '') from kin_people where person_id = '$ZOYA'")" "$BACK" \
  "Arjun marked Zoya away: $refused"
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"Asia/Kolkata\",\"awayUntil\":\"$BACK\"}" >/dev/null
[[ "$(q "select away_until from kin_people where person_id = '$ZOYA'")" == "$BACK" ]] ||
  fail "the owner's away day for Zoya wasn't saved"

TO_ZOYA="Proof a$RUN: the clinic sent the new photos."
out="$(kv tool chief kin_relay "{\"to\":\"Zoya Sheikh\",\"text\":\"$TO_ZOYA\"}" --as-turn-of owner)"
expect_in "$out" "kin_relay: ok" "the relay to Zoya was refused: $out"
[[ "$(q "select count(*) from kin_messages where body = '$TO_ZOYA'")" == 0 ]] ||
  fail "the relay reached Zoya while she is away"
note="$(q "select body from kin_messages where body like 'Zoya Sheikh is away: it arrives at%' order by seq desc limit 1")"
[[ -n "$note" ]] || fail "the owner's chat has no line saying when it arrives"

# Back: what waited lands now, once.
kv as zoya rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"awayUntil\":null}" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(q "select count(*) from kin_messages where body = '$TO_ZOYA'")" == 1 ]] && break
  sleep 1
done
[[ "$(q "select count(*) from kin_messages where body = '$TO_ZOYA'")" == 1 ]] ||
  fail "after I'm back, the held relay isn't in Zoya's chat once"
pass "the owner marked Zoya away until $BACK (Arjun couldn't); the relay waited with \"$note\"; I'm back let it through once"
