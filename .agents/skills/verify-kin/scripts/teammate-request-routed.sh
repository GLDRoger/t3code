#!/usr/bin/env bash
# Zoya asks the Chief of staff for something Finance handles. She may not message Finance, so
# nothing goes there: the owner gets one card. His "Let" allows her and her own words reach
# Finance in her chat with it, at her access. Asked again, it goes straight there and the owner
# reads one quiet line naming who asked whom, never the request.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
FIN="$(q "select agent_id from kin_leads where name = 'Finance'")"
in_chat() { q "select count(*) from kin_messages m join kin_chats c on c.org_id = m.org_id and c.chat_id = m.chat_id where c.direct_key = '$1' and m.body like '%$2%'"; }
# Start where she may not message Finance.
kv as owner rpc kin.lead.access.revoke "{\"agentId\":\"$FIN\",\"personId\":\"$ZOYA\"}" >/dev/null

ASK="Proof r$RUN: what did we bill Orbit Dental last quarter?"
out="$(kv tool chief kin_hand_off '{"to":"Finance","request":"Hers to answer.","wantsAnswer":false}' --as-turn-of zoya --say "$ASK")"
expect_in "$out" "kin_hand_off: ok" "the hand-off was refused: $out"
expect_in "$out" "owner's go-ahead" "the Chief of staff wasn't told it waits on the owner: $out"
[[ "$(in_chat "$ZOYA:$FIN" "Proof r$RUN")" == 0 ]] || fail "her request reached Finance before the owner said so"
kv as zoya web open chat:chief >/dev/null
expect_not_in "$(kv as zoya web snapshot)" "Passed on" "Zoya's chat says it was passed on before the owner said so"

kv as owner web open chat:chief >/dev/null
kv as owner web wait "Zoya Sheikh asked for something Finance handles" >/dev/null || fail "the owner never got the card"
expect_in "$(kv as owner web snapshot)" "Proof r$RUN" "the owner's card doesn't quote her words"
kv as owner web click --name "Let Zoya Sheikh talk to Finance" >/dev/null
kv as owner web wait "Passed on" >/dev/null || fail "the card never said it was passed on"
[[ "$(q "select count(*) from kin_lead_access where agent_id = '$FIN' and person_id = '$ZOYA' and revoked_at is null")" == 1 ]] \
  || fail "the owner's Let made no grant"
origin="$(q "select json_extract(json, '\$.origin.personId') from kin_events where agent_id = '$FIN' and event_id like 'forward-%' order by received_at desc limit 1")"
[[ "$origin" == "$ZOYA" ]] || fail "Finance's wake-up isn't marked as passed on for Zoya: $origin"
kv as zoya web open chat:finance >/dev/null
kv as zoya web wait "Proof r$RUN" >/dev/null || fail "her words never showed in her chat with Finance"
expect_in "$(kv as zoya web snapshot)" "Passed on from your chat with Chief of staff" "her chat with Finance doesn't say it was passed on"

AGAIN="Proof s$RUN: and the quarter before?"
out="$(kv tool chief kin_hand_off '{"to":"Finance","request":"Hers again.","wantsAnswer":false}' --as-turn-of zoya --say "$AGAIN")"
expect_in "$out" '"passed":true' "the second request didn't go straight to Finance: $out"
[[ "$(in_chat "$ZOYA:$FIN" "Proof s$RUN")" == 1 ]] || fail "the second request didn't reach Finance once"
kv as owner web open chat:chief >/dev/null
kv as owner web wait "Zoya Sheikh asked for something Finance handles; it went to Finance." >/dev/null \
  || fail "the owner wasn't told who asked whom"
expect_not_in "$(kv as owner web snapshot)" "Proof s$RUN" "the owner's line shows her request"
kv as owner rpc kin.lead.access.revoke "{\"agentId\":\"$FIN\",\"personId\":\"$ZOYA\"}" >/dev/null
pass "Zoya's request reached Finance after one card, then straight away, at her access"
