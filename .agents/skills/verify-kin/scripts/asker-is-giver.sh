#!/usr/bin/env bash
# Whoever asked gives the task: Zoya asks Chief of staff to give Arjun a task, so it reads
# "Zoya Sheikh gave this to you, via Chief of staff" and Hand back returns it to her. (One the
# agent gives on a turn nobody asked for is the agent's: KinRecords.test.ts, as the driver's turns
# always answer someone.)
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

pass "$task reads as Zoya's, via Chief of staff, and went back to her"
