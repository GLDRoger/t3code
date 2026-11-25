#!/usr/bin/env bash
# A save of many either all lands or none does: Finance files two invoices, the second refused, and
# nothing is saved, the error naming that row; Money's owed total doesn't move. Then the Chief of
# staff drops two tasks with one record_update keys call, and Tasks shows neither.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
TITLE="Proof b$RUN"
kv as owner web open money >/dev/null
owed_before="$(kv as owner web snapshot | grep -i -m1 "owed" || true)"
refused="$(kv tool finance record_create "{\"records\":[{\"list\":\"invoices\",\"title\":\"$TITLE first\",\"amount\":\"1200\"},{\"list\":\"invoices\",\"title\":\"$TITLE second\",\"amount\":\"-500\"}]}" --as-turn-of owner --raw || true)"
expect_in "$refused" "Row 2" "the refused invoice isn't named by its row: $refused"
expect_in "$refused" "Nothing in this call was saved" "the error doesn't say nothing was saved: $refused"
[[ "$(q "select count(*) from kin_records where title like '$TITLE%'")" == "0" ]] ||
  fail "an invoice from the refused call was saved"
kv as owner web open money >/dev/null
[[ "$(kv as owner web snapshot | grep -i -m1 "owed" || true)" == "$owed_before" ]] ||
  fail "Money's owed total moved after a refused call"

made="$(kv tool chief record_create "{\"records\":[{\"title\":\"$TITLE task one\"},{\"title\":\"$TITLE task two\"}]}" --as-turn-of owner --raw)"
keys="$(grep -o 'W-[0-9]*' <<<"$made" | head -2 | paste -sd, - | sed 's/\([^,]*\)/"\1"/g')"
[[ "$keys" == *,* ]] || fail "Chief of staff couldn't make the two tasks: $made"
dropped="$(kv tool chief record_update "{\"keys\":[$keys],\"state\":\"dropped\"}" --as-turn-of owner --raw)"
expect_in "$dropped" "entries" "record_update keys didn't answer per entry: $dropped"
kv as owner web open tasks >/dev/null
expect_not_in "$(kv as owner web snapshot)" "$TITLE task" "a dropped task still shows on Tasks"

pass "a refused row saved nothing and was named; one keys call dropped both tasks"
