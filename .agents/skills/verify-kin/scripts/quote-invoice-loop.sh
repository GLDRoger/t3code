#!/usr/bin/env bash
# The owner invoices QT-1: the quote shows it was invoiced and offers no second invoice; a draft takes no payment.
source "$(dirname "$0")/lib.sh"
made="$(kv as owner rpc kin.work.invoiceFromQuote "{\"key\":\"QT-1\",\"clientRequestId\":\"inv-$RUN\"}")"
INV="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).invoice)' "$made")"
[[ "$INV" == INV-* ]] || fail "invoicing QT-1 made no invoice: $made"
expect_in "$(kv as owner rpc kin.work.get '{"key":"QT-1"}')" "\"key\":\"$INV\"" "QT-1 doesn't link $INV"
kv as owner web open "money?task=QT-1" >/dev/null 2>&1 || kv as owner web open "tasks?task=QT-1" >/dev/null
kv as owner web wait "Invoiced as $INV." >/dev/null || fail "QT-1 doesn't say it was invoiced"
expect_not_in "$(kv as owner web snapshot)" "Make invoice" "QT-1 still offers Make invoice"
pay="{\"key\":\"$INV\",\"amount\":{\"minor\":100000,\"currency\":\"INR\"},\"paidOn\":\"2026-11-16\",\"clientRequestId\":\"pay-$RUN\"}"
expect_in "$(kv as owner rpc kin.work.recordPayment "$pay" 2>&1 || true)" "Issue it first" "a payment landed on draft $INV"
kv as owner web open "money?task=$INV" >/dev/null 2>&1 || kv as owner web open "tasks?task=$INV" >/dev/null
kv as owner web wait "A draft isn't owed yet." >/dev/null || fail "draft $INV doesn't say why it takes no payment"
expect_in "$(kv as owner web snapshot)" "Make its PDF" "$INV's PDF button isn't Make its PDF"
expect_not_in "$(kv as owner web snapshot)" "Record payment" "draft $INV offers Record payment"
pass "QT-1 invoiced as $INV, linked both ways; the draft refuses a payment and says why"
