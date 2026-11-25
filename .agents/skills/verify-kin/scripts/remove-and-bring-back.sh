#!/usr/bin/env bash
# Removing Arjun changes his access only: his task stays his, shows under Needs you as held by
# someone whose access was removed, no agent starts on it, and its history says who removed him.
# His browser then says his access ended instead of asking to pair, and Zoya's chat with him leaves
# her list. A new link from the owner brings him back as the same person: his level, his chat with
# its history, and his task, and Zoya's chat with him is listed again.
# What an agent asked him closes with him, its card saying so, while his task stays his. Adding
# "Arjun Rao" again offers to bring him back instead of making a second person, and yes is the link.
# The owner removes him and makes the new link on the web, from Settings → Team → Arjun, so a
# teammate page that opens out of reach (behind the Settings modal) fails here.
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
ASK="Proof q$RUN: shall I file the clinic photos under 2026?"
asked="$(kv tool chief kin_ask "{\"question\":\"$ASK\",\"options\":[{\"label\":\"File them\"},{\"label\":\"Leave them\"}],\"default\":\"none\",\"intent\":\"file photos $RUN\"}" \
  --as-turn-of arjun --say "Proof a$RUN: where do the photos go?")"
expect_in "$asked" "kin_ask: ok" "Chief of staff couldn't ask Arjun: $asked"
[[ "$(q "select state from kin_questions where question = '$ASK'")" == open ]] ||
  fail "Chief of staff's question to Arjun isn't open"
access="$(q "select access from kin_people where person_id = '$ARJUN'")"
pair="$(kv as zoya rpc kin.chats.withPerson "{\"personId\":\"$ARJUN\"}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).chatId))')"
kv as zoya rpc kin.messages.send "{\"chatId\":\"$pair\",\"clientMessageId\":\"gone-$RUN\",\"body\":\"Proof g$RUN: see you Monday\"}" >/dev/null
zoya_list() { kv as zoya web open home >/dev/null && kv as zoya web snapshot --full; }
# His chat's own row, not another chat's preview that names him.
ROW='link "Arjun Rao,'
expect_in "$(zoya_list)" "$ROW" "Zoya's chat with Arjun isn't on her list"

wakeups="$(q "select count(*) from kin_wakeups")"
kv as owner web open "/kin?settings=team" >/dev/null
kv as owner web click --name "Arjun Rao" >/dev/null || fail "Settings → Team has no Arjun Rao to open"
kv as owner web click --name "Remove access" >/dev/null ||
  fail "Remove access on Arjun's page can't be clicked on the web"
kv as owner web wait "Remove Arjun" >/dev/null || fail "Remove access asked nothing"
kv as owner web click --name "Remove access" >/dev/null || fail "the confirm's Remove access can't be clicked"
for _ in $(seq 1 20); do
  [[ "$(q "select coalesce(removed_at, 'in') from kin_people where person_id = '$ARJUN'")" != in ]] && break
  sleep 1
done
[[ "$(q "select coalesce(removed_at, 'in') from kin_people where person_id = '$ARJUN'")" != in ]] ||
  fail "Remove access on the web didn't remove Arjun"
[[ "$(q "select owner_kind || ':' || owner_id || ':' || state from kin_records where key = '$task'")" == "person:$ARJUN:open" ]] ||
  fail "$task left Arjun when his access was removed"
expect_in "$(q "select c.fields_json from kin_record_changes c join kin_records r on r.record_id = c.record_id where r.key = '$task' order by c.seq desc limit 1")" \
  "accessRemoved" "$task's history doesn't say his access was removed"
[[ "$(q "select state from kin_questions where question = '$ASK'")" == withdrawn ]] ||
  fail "the question to Arjun stayed open after he was removed"
expect_in "$(q "select w.state_json from kin_widgets w join kin_questions k on k.widget_id = w.widget_id where k.question = '$ASK'")" \
  "Arjun Rao was removed from the team; nothing will happen on this." "the question's card doesn't say it closed"
[[ "$(q "select count(*) from kin_waiting where person_id = '$ARJUN' and resolved_at is null")" == 0 ]] ||
  fail "something still waits on Arjun after he was removed"
needs="$(kv as owner rpc kin.pulse.read '{"acceptSenses":["holder_removed"]}')"
expect_in "$needs" "whose access was removed" "Needs you doesn't show $task held by someone removed"
sleep 5
[[ "$(q "select count(*) from kin_wakeups")" == "$wakeups" ]] || fail "an agent started work when Arjun was removed"

expect_not_in "$(zoya_list)" "$ROW" "Zoya's chat with Arjun stayed listed after his access ended"

kv as arjun web open /kin >/dev/null || true
kv as arjun web wait "Your access to Kin has ended" >/dev/null ||
  fail "Arjun's browser doesn't say his access ended"

kv as owner web wait "Make a new link" >/dev/null || fail "Arjun's page offers no new link once removed"
# Adding him by name again is the same way back, never a second Arjun.
people="$(q "select count(*) from kin_people")"
kv as owner web open "/kin?settings=team" >/dev/null
kv as owner web click --name "Add teammate" >/dev/null || fail "Team has no Add teammate"
kv as owner web type --name "Their name" "Arjun Rao" >/dev/null
kv as owner web click --name "Make link" >/dev/null || fail "Make link can't be clicked"
kv as owner web wait "Bring back Arjun Rao (removed" >/dev/null ||
  fail "adding Arjun Rao again didn't offer to bring him back"
[[ "$(q "select count(*) from kin_people")" == "$people" ]] || fail "adding Arjun Rao again made a second person"
kv as owner web click --name "Bring back Arjun Rao" >/dev/null || fail "Bring back can't be clicked"
kv as owner web wait "Copy link" >/dev/null || fail "Bring back showed no link"
secret="$(kv as owner web snapshot | grep -o 'invite#[A-Za-z0-9._~-]*' | head -1 | cut -d'#' -f2)"
[[ -n "$secret" ]] || fail "the new link isn't on the owner's screen"
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
expect_in "$(zoya_list)" "$ROW" "Zoya's chat with Arjun didn't come back when he did"
[[ "$(q "select count(*) from kin_people")" == "$people" ]] || fail "bringing Arjun back made a second person"
pass "removing Arjun from his page in web Settings kept $task his, under Needs you, with no agent started, and closed Chief of staff's question to him; his browser said his access ended and Zoya's chat with him left her list; adding Arjun Rao again offered to bring him back, and that link brought back his level, chat history and task, and that chat"
