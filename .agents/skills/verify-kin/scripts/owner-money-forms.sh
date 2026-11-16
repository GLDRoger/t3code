#!/usr/bin/env bash
# The owner sets a goal, reads the coming-up dates, and sets an advance against INV-1 on Money; members can do none of it.
source "$(dirname "$0")/lib.sh"
day() { DAYS="$1" node -e 'const d=new Date();d.setDate(d.getDate()+Number(process.env.DAYS));process.stdout.write(d.toISOString().slice(0,10))'; }
GOAL="Ship two pilots $RUN"
kv as owner rpc kin.goals.save "{\"title\":\"$GOAL\",\"measure\":\"manual\",\"target\":\"2\",\"current\":0,\"startsOn\":\"$(day 0)\",\"dueOn\":\"$(day 45)\",\"clientRequestId\":\"goal-$RUN\"}" >/dev/null
expect_in "$(kv as owner rpc kin.goals.list)" "$GOAL" "the owner's goals don't list the new goal"
for person in zoya dev; do
  body="{\"title\":\"Not mine $RUN\",\"measure\":\"manual\",\"target\":\"1\",\"startsOn\":\"$(day 0)\",\"dueOn\":\"$(day 9)\",\"clientRequestId\":\"goal-$person-$RUN\"}"
  refused="$(kv as "$person" rpc kin.goals.save "$body" 2>&1 || true)"
  expect_in "$refused" "Only the owner or a co-owner" "$person could set a goal"
done
# Dates: INV-1's due and P-2's renewal, on the owner's Money; a member can't read them.
kv as owner web open money >/dev/null
kv as owner web click --name "Coming-up dates" >/dev/null 2>&1 ||
  kv as owner web click --name "$(kv as owner web snapshot | grep -oE 'Coming-up dates [^"]*' | head -1)" >/dev/null
dates="$(kv as owner web snapshot)"
expect_in "$dates" "Renewal due" "the owner's dates don't show P-2's renewal"
expect_in "$dates" "· INV-1 ·" "the owner's dates don't show INV-1"
window="{\"from\":\"$(day -30)\",\"to\":\"$(day 30)\"}"
expect_in "$(kv as zoya rpc kin.work.dates "$window" 2>&1 || true)" "not_allowed" "Zoya can read the dates"
# Receipt: an advance from Orbit Dental, set against INV-1 in the Set against dialog, once.
body="{\"advance\":{\"client\":\"C-2\",\"amount\":{\"minor\":100000,\"currency\":\"INR\"},\"receivedOn\":\"$(day 0)\"},\"towards\":\"Advance $RUN\",\"clientRequestId\":\"rct-$RUN\"}"
made="$(kv as owner rpc kin.work.makeReceipt "$body")"
receipt="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).receipt.key)' "$made")"
kv as owner web open money >/dev/null
kv as owner web click --name "$(kv as owner web snapshot | grep -oE 'Receipts [0-9]+ receipts?' | head -1)" >/dev/null
expect_in "$(kv as owner web snapshot)" "Advance $RUN Not set against an invoice yet" "the new advance isn't on Money"
kv as owner web click --name "Set against invoice" >/dev/null
kv as owner web click --name "Set against invoice" >/dev/null
kv as owner web wait "Receipt " >/dev/null || fail "setting $receipt against INV-1 said nothing"
expect_in "$(kv as owner rpc kin.work.receipts '{}')" "\"key\":\"$receipt\"" "kin.work.receipts lost $receipt"
applied="$(kv as owner rpc kin.work.receipts '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String((r.receipts??r.rows??[]).find(x=>x.key===process.argv[1])?.invoice))})' "$receipt")"
[[ "$applied" == "INV-1" ]] || fail "$receipt is set against '$applied', not INV-1"
body="{\"key\":\"$receipt\",\"against\":\"INV-1\",\"clientRequestId\":\"rct-again-$RUN\"}"
again="$(kv as owner rpc kin.work.makeReceipt "$body" 2>&1 || true)"
expect_in "$again" "\"invoice\":\"INV-1\"" "setting it again didn't answer with the same receipt"
body="{\"key\":\"$receipt\",\"against\":\"INV-1\",\"clientRequestId\":\"rct-z-$RUN\"}"
expect_in "$(kv as zoya rpc kin.work.makeReceipt "$body" 2>&1 || true)" "Only the owner or a co-owner" "Zoya could set a receipt"
pass "goal $GOAL saved, dates show INV-1 and P-2, $receipt set against INV-1 once; Zoya and Dev refused"
