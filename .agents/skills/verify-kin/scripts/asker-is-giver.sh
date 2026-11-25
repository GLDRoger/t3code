#!/usr/bin/env bash
# Whoever asked gives the task: Zoya asks Chief of staff to give Arjun a task, so it reads
# "Zoya Sheikh gave this to you, via Chief of staff" and Hand back returns it to her. (One the
# agent gives on a turn nobody asked for is the agent's: KinRecords.test.ts, as the driver's turns
# always answer someone.) Then "me" in a turn is the person who asked: the owner, then Zoya.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
TITLE="Proof g$RUN: resize the clinic photos"
made="$(kv tool chief record_create "{\"records\":[{\"title\":\"$TITLE\",\"owner\":\"Arjun Rao\"}]}" --as-turn-of zoya --say "Ask Arjun to resize the clinic photos." --raw)"
task="$(grep -o 'W-[0-9]*' <<<"$made" | head -1)"
[[ -n "$task" ]] || fail "Chief of staff couldn't give Arjun the task: $made"
[[ "$(q "select coalesce(assigned_by_person_id, '') || '|' || coalesce(assigned_by_agent_id, '') from kin_records where key = '$task'")" == "$ZOYA|" ]] ||
  fail "$task's giver isn't Zoya alone"
kv as arjun web open tasks >/dev/null
kv as arjun web wait "$TITLE" >/dev/null || fail "Arjun's Tasks never showed $task"
kv as arjun web click --name "$TITLE. You" >/dev/null
kv as arjun web wait "gave this to you, via Chief of staff" >/dev/null ||
  fail "Arjun's task doesn't say who gave it, via whom"
expect_in "$(kv as arjun web snapshot)" "Zoya" "Arjun's task doesn't name Zoya as the giver"
back="$(kv as arjun rpc kin.work.handBack "{\"key\":\"$task\",\"note\":\"No time this week\"}")"
expect_in "$back" "\"personId\":\"$ZOYA\"" "handed back, $task didn't go to Zoya: $back"

# "me" is whoever asked in the turn, never the agent: the owner's "give it to me" lands on her list,
# and Zoya's on hers.
OWNER="$(q "select owner_person_id from kin_agents where display_name = 'Chief of staff'")"
mine() { # <turn of> <person id> <title>
  local made key given
  made="$(kv tool chief record_create "{\"records\":[{\"title\":\"$3\"}]}" --as-turn-of "$1" --raw)"
  key="$(grep -o 'W-[0-9]*' <<<"$made" | head -1)"
  [[ -n "$key" ]] || fail "Chief of staff couldn't track \"$3\" in $1's turn: $made"
  given="$(kv tool chief record_assign "{\"tasks\":[{\"key\":\"$key\",\"to\":\"me\",\"reason\":\"asked\"}]}" --as-turn-of "$1" --raw)"
  expect_not_in "$given" "(you)" "\"me\" in $1's turn gave $key to Chief of staff: $given"
  [[ "$(q "select owner_kind || '|' || owner_id from kin_records where key = '$key'")" == "person|$2" ]] ||
    fail "\"me\" in $1's turn didn't put $key on their list: $given"
  echo "$key"
}
MINE="$(mine owner "$OWNER" "Proof g$RUN: book the fair stand")"
kv as owner web open "tasks?task=$MINE" >/dev/null
kv as owner web wait "You have this" >/dev/null || fail "the owner's $MINE doesn't say she has it"
expect_not_in "$(kv as owner web snapshot)" "Chief of staff has this" "$MINE still reads as the agent's"
ZOYAS="$(mine zoya "$ZOYA" "Proof g$RUN: pick the stand colours")"

pass "$task reads as Zoya's, via Chief of staff, and went back to her; \"me\" gave $MINE to the owner and $ZOYAS to Zoya"
