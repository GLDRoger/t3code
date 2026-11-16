#!/usr/bin/env bash
# P-1's members see its milestones and no way to add one; Dev, its lead, adds one on the project page and they see it.
source "$(dirname "$0")/lib.sh"
NAME="Pilot clinics live $RUN"
for person in zoya arjun; do
  kv as "$person" web open "clients?project=P-1" >/dev/null
  page="$(kv as "$person" web snapshot)"
  expect_in "$page" "Booking flow ready" "$person's project page doesn't show M-1"
  expect_not_in "$page" "No milestones yet" "$person's project page says there are no milestones"
  expect_not_in "$page" "Add milestone" "$person is offered Add milestone"
done
kv as dev web open "clients?project=P-1" >/dev/null
kv as dev web click --name "Add milestone" >/dev/null
kv as dev web type --name "Name" "$NAME" >/dev/null
kv as dev web click --name "Add milestone" >/dev/null
kv as dev web wait "$NAME" >/dev/null || fail "Dev's new milestone isn't on his project page"
expect_in "$(kv db "select project_id is not null from kin_records where register_id = 'milestones' and title = '$NAME'" | tail -1)" "1" "the milestone isn't filed under P-1"
kv as zoya web open "clients?project=P-1" >/dev/null
kv as zoya web wait "$NAME" >/dev/null || fail "Zoya doesn't see Dev's milestone"
pass "Zoya and Arjun see M-1 and no Add milestone; Dev added \"$NAME\" and Zoya sees it"
