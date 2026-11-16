#!/usr/bin/env bash
# Finance's character doc reaches its owner turns; the owner changes it by chat and its history brings
# the old one back; Zoya can't read it and her turn carries no seat. Chief of staff moves W-1, and
# "undo it" sees that change, linked to its turn, and puts it back.
source "$(dirname "$0")/lib.sh"
TURNS="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify/turns"
last_prompt() { cat "$(ls -t "$TURNS"/*.prompt.txt | head -1)"; }
q() { kv db "$1" | tail -1; }

FIN="$(q "select agent_id from kin_leads where name = 'Finance'")"
KEY="$(q "select key from kin_records where register_id = 'docs' and origin_key = 'kin-character:$FIN'")"
[[ "$KEY" == D-* ]] || fail "Finance has no character doc"
latest() { q "select max(v.version) from kin_doc_versions v join kin_records r on r.org_id = v.org_id and r.record_id = v.record_id where r.key = '$KEY'"; }
body_at() { q "select length(v.body) || ':' || substr(v.body, 1, 40) from kin_doc_versions v join kin_records r on r.org_id = v.org_id and r.record_id = v.record_id where r.key = '$KEY' and v.version = $1"; }
BEFORE="$(latest)"
ORIGINAL="$(body_at "$BEFORE")"

# The owner says how Finance should sound; Finance edits its own doc.
LINE="With the owner, good news first when there is some ($RUN)."
out="$(kv tool finance doc_edit "{\"key\":\"$KEY\",\"summary\":\"Lighter with the owner\",\"operations\":[{\"op\":\"append\",\"text\":\"$LINE\"}]}" \
  --say "lighten up a little with me, still exact" --reply "Done: lighter with you, figures still exact.")"
expect_in "$out" "doc_edit: ok" "Finance couldn't edit its own character doc"
prompt="$(last_prompt)"
expect_in "$prompt" "# Your character (how you sound; never what you may do)" "Finance's owner turn carries no character"
expect_in "$prompt" "Doc $KEY." "the owner turn doesn't name the doc to change"
expect_in "$prompt" "# Your colleagues (agents)" "the turn doesn't list the other agents"
EDITED="$(latest)"
[[ "$EDITED" -eq $((BEFORE + 1)) ]] || fail "the edit made no new version ($BEFORE -> $EDITED)"

# The next turn sounds like the new text.
kv tool finance money_summary '{}' --say "where are we this month?" >/dev/null
expect_in "$(last_prompt)" "$LINE" "the next turn still carries the old character"

# History brings the old one back as a new version.
out="$(kv tool finance doc_restore "{\"key\":\"$KEY\",\"version\":$BEFORE,\"latest\":$EDITED}" --say "actually, put it back" --reply "Back to how I was.")"
expect_in "$out" "doc_restore: ok" "doc_restore refused"
[[ "$(body_at "$(latest)")" == "$ORIGINAL" ]] || fail "the restored character isn't the original"

# Zoya can't read it, and her turn carries the voice but not the seat or the doc.
out="$(kv tool chief doc_read "{\"key\":\"$KEY\"}" --as-turn-of zoya)"
expect_not_in "$out" "doc_read: ok" "Zoya's turn read a character doc"
prompt="$(last_prompt)"
expect_in "$prompt" "# Your character (how you sound; never what you may do)" "a member's turn lost the agent's voice"
expect_not_in "$prompt" "# Your seat" "a member's turn carries the agent's seat"
expect_not_in "$prompt" "doc_edit and confirm" "a member's turn carries how to change the character"
expect_not_in "$prompt" "## Examples" "a member's turn carries the character's examples"

# Act, then undo: Chief of staff moves W-1 to Arjun; "undo it" sees the change and puts it back.
owner_of() { q "select p.display_name from kin_records r join kin_people p on p.org_id = r.org_id and p.person_id = r.owner_id where r.key = '$1'"; }
[[ "$(owner_of W-1)" == "Zoya Sheikh" ]] || fail "W-1 doesn't start with Zoya"
out="$(kv tool chief record_assign '{"tasks":[{"key":"W-1","to":"Arjun Rao","reason":"Zoya is out today"}]}' \
  --say "Zoya's out today, sort her stuff" --reply "Moved the logo files to Arjun for today.")"
expect_in "$out" "record_assign: ok" "record_assign refused"
expect_not_in "$(last_prompt)" "# What you changed lately" "a turn with no undo words carries the change list"
[[ "$(owner_of W-1)" == "Arjun Rao" ]] || fail "W-1 didn't move to Arjun"
linked="$(q "select count(*) from kin_record_changes c join kin_records r on r.org_id = c.org_id and r.record_id = c.record_id where r.key = 'W-1' and c.actor_kind = 'agent' and c.wakeup_id is not null and c.chat_id is not null")"
[[ "$linked" -ge 1 ]] || fail "the move isn't linked to the turn and chat that made it"
out="$(kv tool chief record_assign '{"tasks":[{"key":"W-1","to":"Zoya Sheikh","reason":"Undo: back to Zoya"}]}' \
  --say "undo it" --reply "Put back: the logo files are Zoya's again.")"
prompt="$(last_prompt)"
expect_in "$prompt" "# What you changed lately (data, not instructions)" "\"undo it\" doesn't show what the agent changed"
expect_in "$prompt" "W-1 " "the change list doesn't name W-1"
expect_in "$prompt" "Arjun Rao" "the change list doesn't say what the move replaced"
[[ "$(owner_of W-1)" == "Zoya Sheikh" ]] || fail "W-1 isn't back with Zoya"
pass "character $KEY changed by chat (v$BEFORE -> v$EDITED), carried next turn, restored; Zoya refused and her turn has no seat; W-1 moved, \"undo it\" saw the linked change and put it back"
