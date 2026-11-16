#!/usr/bin/env bash
# Finance's page: a new model reaches the next turn and an unavailable one is refused; its character
# changes from the page and its history brings the old one back; pause stops its turns and resume
# brings them back; retire and restore; Zoya gets neither the page nor a way to change it.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -1; }
FIN="$(q "select agent_id from kin_leads where name = 'Finance'")"
page() { kv as owner rpc kin.lead.page "{\"agentId\":\"$FIN\"}"; }
last_model() { q "select model from kin_wakeups where agent_id = '$FIN' order by started_at desc, rowid desc limit 1"; }
script_models() { echo "{\"strong\":{\"instanceId\":\"kinVerifyScript\",\"model\":\"$1\"},\"cheap\":{\"instanceId\":\"kinVerifyScript\",\"model\":\"script\"}}"; }

# A new model applies on the next turn, with no restart.
kv as owner rpc kin.lead.update "{\"agentId\":\"$FIN\",\"models\":$(script_models script-b)}" >/dev/null ||
  fail "the owner couldn't change Finance's model"
expect_in "$(page)" "\"runsOn\":{\"strong\":{\"instanceId\":\"kinVerifyScript\",\"model\":\"script-b\"}" "the page doesn't show the new model"
kv tool finance money_summary '{}' --say "where are we this month?" >/dev/null
[[ "$(last_model)" == "script-b" ]] || fail "the next turn ran on $(last_model), not script-b"

# A model this server doesn't have is refused, and Finance keeps the one it had.
refused="$(kv as owner rpc kin.lead.update "{\"agentId\":\"$FIN\",\"models\":{\"strong\":{\"instanceId\":\"codex\",\"model\":\"gpt-5\"},\"cheap\":{\"instanceId\":\"codex\",\"model\":\"gpt-5\"}}}" 2>&1 || true)"
expect_in "$refused" "Claude" "a non-Claude model was accepted"
expect_in "$(page)" "script-b" "a refused change still changed the model"

# By chat: the owner asks Chief of staff; a member's turn is refused. Saved means this host has
# Claude, so Finance goes straight back to the scripted model before it takes another turn.
out="$(kv tool chief agent_update '{"agent":"Finance","model":"sonnet"}' --say "run Finance on Sonnet" --reply "Done.")"
contains "$out" "agent_update: ok" || expect_in "$out" "isn't available" "the owner's chat change was refused"
kv as owner rpc kin.lead.update "{\"agentId\":\"$FIN\",\"models\":$(script_models script)}" >/dev/null
out="$(kv tool chief agent_update '{"agent":"Finance","model":"sonnet"}' --as-turn-of zoya)"
expect_not_in "$out" "agent_update: ok" "a member's turn changed Finance's model"

# The character changes from the page, and its history restores the old one as a new version.
KEY="$(q "select key from kin_records where register_id = 'docs' and origin_key = 'kin-character:$FIN'")"
latest() { q "select max(v.version) from kin_doc_versions v join kin_records r on r.org_id = v.org_id and r.record_id = v.record_id where r.key = '$KEY'"; }
body_at() { q "select v.body from kin_doc_versions v join kin_records r on r.org_id = v.org_id and r.record_id = v.record_id where r.key = '$KEY' and v.version = $1"; }
BEFORE="$(latest)"
LINE="Lead with the bank balance ($RUN)."
out="$(kv as owner rpc kin.lead.character.set "{\"agentId\":\"$FIN\",\"body\":\"# Finance\\n\\n$LINE\"}")"
expect_in "$out" "$LINE" "the page doesn't show the saved character"
EDITED="$(latest)"
[[ "$EDITED" -eq $((BEFORE + 1)) ]] || fail "saving made no new version ($BEFORE -> $EDITED)"
kv as owner rpc kin.docs.restore "{\"key\":\"$KEY\",\"version\":$BEFORE,\"latest\":$EDITED}" >/dev/null ||
  fail "the owner couldn't restore the old character"
[[ "$(body_at "$(latest)")" == "$(body_at "$BEFORE")" ]] || fail "the restored character isn't the old one"
expect_not_in "$(page)" "$LINE" "the page still shows the replaced character"

# Paused, Finance takes no turns; resumed, it does again.
kv as owner rpc kin.lead.pause "{\"agentId\":\"$FIN\"}" >/dev/null || fail "pause refused"
expect_in "$(page)" "\"paused\":{\"at\":" "the page doesn't say Finance is paused"
[[ "$(q "select count(*) from kin_agents where agent_id = '$FIN' and paused_at is not null")" == 1 ]] || fail "pause wasn't stored"
kv as owner rpc kin.lead.resume "{\"agentId\":\"$FIN\"}" >/dev/null || fail "resume refused"
expect_not_in "$(page)" "\"paused\":{\"at\":" "the page still says paused"
kv tool finance money_summary '{}' --say "and now?" >/dev/null || fail "Finance took no turn after resuming"

# Retired and brought back.
kv as owner rpc kin.lead.retire "{\"agentId\":\"$FIN\"}" >/dev/null || fail "retire refused"
expect_in "$(page)" "\"retired\":{" "the page doesn't say Finance is retired"
kv as owner rpc kin.lead.restore "{\"agentId\":\"$FIN\"}" >/dev/null || fail "restore refused"
expect_not_in "$(page)" "\"retired\":{" "Finance is still retired"

# A member gets neither the page (model, character, access) nor any way to change it.
for method in kin.lead.page kin.lead.pause kin.lead.access.list; do
  out="$(kv as zoya rpc "$method" "{\"agentId\":\"$FIN\"}" 2>&1 || true)"
  expect_not_in "$out" "\"models\"" "Zoya read Finance's models through $method"
  expect_not_in "$out" "\"character\"" "Zoya read Finance's character through $method"
  [[ "$(q "select count(*) from kin_agents where agent_id = '$FIN' and paused_at is not null")" == 0 ]] || fail "Zoya paused Finance"
done
out="$(kv as zoya rpc kin.lead.update "{\"agentId\":\"$FIN\",\"models\":$(script_models "zoya-$RUN")}" 2>&1 || true)"
expect_not_in "$(page)" "zoya-$RUN" "Zoya changed Finance's model"
out="$(kv as zoya rpc kin.lead.character.set "{\"agentId\":\"$FIN\",\"body\":\"zoya-$RUN\"}" 2>&1 || true)"
[[ "$(latest)" == "$((EDITED + 1))" ]] || fail "Zoya's character change made a version"
pass "model script-b reached the next turn, a non-Claude one refused; character $KEY v$BEFORE -> v$EDITED restored; paused and resumed; retired and restored; Zoya refused the page, its model and its character"
