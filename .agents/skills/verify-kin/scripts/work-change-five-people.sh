#!/usr/bin/env bash
# Meera adds a task, the owner gives it to Zoya, then takes it back, while five people have Tasks
# open. Each page gets the task itself or nothing, sends no Work read, and shows it come and go.
source "$(dirname "$0")/lib.sh"
PEOPLE=(owner meera dev zoya arjun)
TITLE="Proof $RUN: send the venue the floor plan"
id_of() { kv people | awk -F'\t' -v who="$1" '$1 == who { print $3 }'; }
for one in "${PEOPLE[@]}"; do kv as "$one" web open tasks >/dev/null; done
# Let each page finish its own first reads before anything is counted.
sleep 4
watch() { kv as "$1" wire "$2" "$3" --watch "$(IFS=,; echo "${PEOPLE[*]}")" --settle 5 --find "$RUN"; }
row() { jq -c --arg who "$2" 'select(.person == $who)' <<<"$1"; }
# Reads a page made because of the change: Work's list and counts are the ones this change moves.
work_reads() { jq -s '[.[] | select(.person) | (.methods["kin.work.list"] // 0) + (.methods["kin.work.summary"] // 0)] | add' <<<"$1"; }
total() { jq -s "[.[] | select(.person) | .$2] | add" <<<"$1"; }
# The task's own row in their list; a chat notice also names the task, so the row is what counts.
row_shown() { contains "$(kv as "$1" web snapshot)" "button \"$TITLE"; }
report() { echo "     $1: $(total "$2" bytesIn) B in, $(total "$2" deflatedIn) B deflated, $(total "$2" requests) requests; $(jq -sc '[.[] | select(.person) | "\(.person) \(.bytesIn)/\(.requests)"] | join(", ")' <<<"$2")" >&2; }

made=$(watch meera kin.work.create "{\"clientRequestId\":\"proof-$RUN\",\"title\":\"$TITLE\"}")
KEY=$(head -1 <<<"$made" | jq -r '.result.key')
[[ "$KEY" == W-* ]] || fail "the task wasn't made: $(head -1 <<<"$made")"
report "Meera adds $KEY" "$made"
[[ $(work_reads "$made") -eq 0 ]] || fail "a page read Work again after the new task"
for one in owner meera; do
  [[ $(row "$made" "$one" | jq .found) -ge 1 ]] || fail "$one's page never got the new task"
  row_shown "$one" || fail "$one's Tasks doesn't show $KEY"
done
for one in dev zoya arjun; do
  [[ $(row "$made" "$one" | jq .found) -eq 0 ]] || fail "$one's page was sent a task they can't see"
  expect_not_in "$(kv as "$one" web snapshot)" "$TITLE" "$one sees Meera's unshared task"
done

gave=$(watch owner kin.work.assign "{\"key\":\"$KEY\",\"to\":{\"_tag\":\"person\",\"personId\":\"$(id_of zoya)\"}}")
report "owner gives it to Zoya" "$gave"
[[ $(work_reads "$gave") -eq 0 ]] || fail "a page read Work again after the assignment"
[[ $(row "$gave" zoya | jq .found) -ge 1 ]] || fail "Zoya's page never got her new task"
row_shown zoya || fail "Zoya's Tasks doesn't show $KEY"
for one in dev arjun; do
  [[ $(row "$gave" "$one" | jq .found) -eq 0 ]] || fail "$one's page was sent Zoya's task"
  expect_not_in "$(kv as "$one" web snapshot)" "$TITLE" "$one sees Zoya's task"
done

back=$(watch owner kin.work.assign "{\"key\":\"$KEY\",\"to\":{\"_tag\":\"person\",\"personId\":\"$(id_of owner)\"}}")
report "owner takes it back" "$back"
[[ $(work_reads "$back") -eq 0 ]] || fail "a page read Work again after taking the task back"
row_shown zoya && fail "$KEY stayed in Zoya's Tasks after it left her"
for one in dev arjun; do
  [[ $(row "$back" "$one" | jq .found) -eq 0 ]] || fail "$one's page was told of a task they never saw"
done
row_shown owner || fail "the owner lost the task he took back"
pass "five pages got $KEY itself or nothing, read Work 0 times, and showed it come and go"
