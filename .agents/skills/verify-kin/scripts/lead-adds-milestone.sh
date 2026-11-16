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
# New task offers only projects the host lets them file under: Dev's own P-1, never P-2 he is only on.
kv as dev web open tasks >/dev/null
kv as dev web click --name "New task" >/dev/null
kv as dev web click --name "Project" --role combobox >/dev/null
options="$(kv as dev web snapshot --full)"
expect_in "$options" 'option "Lumen Grove patient booking app"' "Dev's New task doesn't offer P-1, which he leads"
expect_not_in "$options" 'option "Orbit Dental care retainer"' "Dev's New task offers P-2, which he doesn't lead"
kv as zoya web open tasks >/dev/null
kv as zoya web click --name "New task" >/dev/null
form="$(kv as zoya web snapshot)"
expect_not_in "$form" 'combobox "Client"' "Zoya, who leads nothing, is offered a client the host refuses"
expect_not_in "$form" 'combobox "Project"' "Zoya, who leads nothing, is offered a project the host refuses"
pass "Zoya and Arjun see M-1 and no Add milestone; Dev added \"$NAME\" and Zoya sees it; New task offers Dev only P-1 and Zoya no client or project"
