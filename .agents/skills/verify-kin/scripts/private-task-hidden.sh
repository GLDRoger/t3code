#!/usr/bin/env bash
# The owner marks W-6 "Only me"; the project's lead and members find it nowhere: Tasks, the project page (which loads for each) and its count, search, pulse.
source "$(dirname "$0")/lib.sh"
TITLE="Beta release to two pilot clinics"
# A task each of them holds in P-1, by title: rows show who has it, not the key.
holds() {
  case "$1" in
    dev) echo "Set up the appointments API" ;;
    zoya) echo "Design the booking flow screens" ;;
    arjun) echo "SMS reminder integration" ;;
  esac
}
kv as owner web open "tasks?task=W-6" >/dev/null
kv as owner web click --name "Who can see this" >/dev/null
kv as owner web click --name "Only me" --role menuitemradio >/dev/null
kv as owner web wait "Only you" >/dev/null || fail "the owner's sheet never said 'Only you'"
kv as owner web open tasks >/dev/null
expect_in "$(kv as owner web snapshot)" "$TITLE" "the owner lost his own private task"
for person in dev zoya arjun; do
  kv as "$person" web open tasks >/dev/null
  expect_not_in "$(kv as "$person" web snapshot --full)" "$TITLE" "$person's Tasks shows it"
  kv as "$person" web open "clients?project=P-1" >/dev/null
  page="$(kv as "$person" web snapshot --full)"
  expect_not_in "$page" "$TITLE" "$person's project page shows it"
  expect_not_in "$page" "W-6" "$person's project page shows its key"
  # A page that failed to load hides everything: each must list a task this person holds.
  expect_not_in "$page" "Couldn't load Work" "$person's project page can't load its tasks"
  expect_in "$page" "$(holds "$person")" "$person's project page doesn't list their own task"
  expect_not_in "$(kv as "$person" rpc kin.search "{\"text\":\"Beta release\"}")" "W-6" "$person's search finds it"
  expect_not_in "$(kv as "$person" rpc kin.pulse.read)" "W-6" "$person's pulse names it"
done
# The project's lead sees a count; it must be the count of the tasks he is shown.
kv as dev web open "clients?project=P-1" >/dev/null
page="$(kv as dev web snapshot)"
count="$(grep -oE '[0-9]+ open' <<<"$page" | head -1 | cut -d' ' -f1)"
rows="$(grep -c 'button "Mark done: ' <<<"$page" || true)"
[[ "$count" == "$rows" ]] || fail "Dev's project page says $count open but lists $rows tasks"
pass "W-6 is hidden from Dev, Zoya and Arjun everywhere; Dev's count ($count) matches his list"
