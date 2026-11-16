#!/usr/bin/env bash
# Removing Arjun changes his access only: his task stays his, shows under Needs you as held by
# someone whose access was removed, no agent starts on it, and its history says who removed him.
# His browser then says his access ended instead of asking to pair. A new link from the owner
# brings him back as the same person: his level, his chat with its history, and his task.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
ARJUN="$(q "select person_id from kin_people where display_name = 'Arjun Rao'")"
TITLE="Proof b$RUN: label the clinic photo folders"
SAID="Proof s$RUN: I'll start on the photo folders tomorrow."
# His browser signs in now, while he is in; after removal it may not sign him back in.
kv as arjun web open chat:chief >/dev/null
made="$(kv tool chief record_create "{\"records\":[{\"title\":\"$TITLE\",\"owner\":\"Arjun Rao\"}]}" --as-turn-of owner --raw)"
task="$(grep -o 'W-[0-9]*' <<<"$made" | head -1)"
[[ -n "$task" ]] || fail "couldn't give Arjun a task: $made"
kv tool chief pulse_read '{}' --as-turn-of arjun --say "$SAID" >/dev/null
access="$(q "select access from kin_people where person_id = '$ARJUN'")"

wakeups="$(q "select count(*) from kin_wakeups")"
removed="$(kv as owner rpc kin.people.removeAccess "{\"personId\":\"$ARJUN\"}")"
expect_in "$removed" '"revoked":true' "removing Arjun failed: $removed"
[[ "$(q "select owner_kind || ':' || owner_id || ':' || state from kin_records where key = '$task'")" == "person:$ARJUN:open" ]] ||
  fail "$task left Arjun when his access was removed"
expect_in "$(q "select c.fields_json from kin_record_changes c join kin_records r on r.record_id = c.record_id where r.key = '$task' order by c.seq desc limit 1")" \
  "accessRemoved" "$task's history doesn't say his access was removed"
needs="$(kv as owner rpc kin.pulse.read '{"acceptSenses":["holder_removed"]}')"
expect_in "$needs" "whose access was removed" "Needs you doesn't show $task held by someone removed"
sleep 5
[[ "$(q "select count(*) from kin_wakeups")" == "$wakeups" ]] || fail "an agent started work when Arjun was removed"

kv as arjun web open /kin >/dev/null || true
kv as arjun web wait "Your access to Kin has ended" >/dev/null ||
  fail "Arjun's browser doesn't say his access ended"

secret="$(kv as owner rpc kin.people.createInvite "{\"displayName\":\"Arjun Rao\",\"personId\":\"$ARJUN\"}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).secret))')"
kv as arjun web open "/kin/invite#$secret" >/dev/null
for _ in $(seq 1 30); do
  [[ "$(q "select coalesce(removed_at, 'back') from kin_people where person_id = '$ARJUN'")" == back ]] && break
  sleep 1
done
[[ "$(q "select access from kin_people where person_id = '$ARJUN'")" == "$access" ]] ||
  fail "Arjun didn't come back as $access"
[[ "$(q "select count(*) from kin_chat_members where person_id = '$ARJUN' and left_at is not null")" == 0 ]] ||
  fail "Arjun came back outside some of his chats"
# The driver's stored session for him was revoked; it signs in again on next use.
rm -f "$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify/sessions/arjun.json"
kv as arjun web open chat:chief >/dev/null
kv as arjun web wait "$SAID" >/dev/null || fail "Arjun's chat came back without its history"
kv as arjun web open tasks >/dev/null
kv as arjun web wait "$TITLE" >/dev/null || fail "Arjun's task isn't his after he came back"
pass "removing Arjun kept $task his, under Needs you, with no agent started; his browser said his access ended; a new link brought back his level, chat history and task"
