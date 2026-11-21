#!/usr/bin/env bash
# INV-1 is past due: the owner's pulse holds the fact (members' don't), and the reminder is a reply in the invoice's own thread.
source "$(dirname "$0")/lib.sh"
fact="$(kv as owner rpc kin.pulse.read)"
expect_in "$fact" '"key":"invoice_overdue:INV-1' "the owner's pulse has no overdue fact for INV-1"
expect_in "$fact" "past due" "the overdue fact doesn't say it is past due"
expect_not_in "$(kv as zoya rpc kin.pulse.read)" "INV-1" "Zoya's pulse names the invoice"
kv as owner web open money >/dev/null
expect_in "$(kv as owner web snapshot)" "INV/26-27/004" "Money's Needs attention doesn't show INV-1 by its number"
# The invoice's thread: its first sending, made here if no earlier script sent it.
invoice="$(kv mail sent | grep 'INV/26-27/004' | grep -v inReplyTo | tail -1 || true)"
if [[ -z "$invoice" ]]; then
  "$(dirname "$0")/send-card-once.sh" >/dev/null
  invoice="$(kv mail sent | grep 'INV/26-27/004' | grep -v inReplyTo | tail -1)"
fi
thread="$(cut -d' ' -f3 <<<"$invoice")"
# A reply answers the newest message in the thread.
newest="$(kv mail sent | grep "· $thread ·" | tail -1 | cut -d' ' -f1)"
before="$(sent_count)"
BODY="Proof $RUN: a gentle reminder that INV/26-27/004 is past due."
OUT="$(kv tool finance kin_connection_call "{\"connection\":\"hello@ambermill.example\",\"tool\":\"mail_reply\",\"arguments\":{\"threadId\":\"$thread\",\"body\":\"$BODY\"},\"reason\":\"overdue invoice reminder\"}")"
expect_in "$OUT" "Nothing was sent" "the reminder didn't wait for the owner: $OUT"
kv as owner web open chat:finance >/dev/null
kv as owner web wait "Reply in this thread" >/dev/null || fail "no reply card in the owner's chat"
kv as owner web click --name Confirm --within "Send this reply" >/dev/null
[[ "$(sent_count)" == "$((before + 1))" ]] || fail "Confirm on the reminder sent $(($(sent_count) - before)) mails"
reply="$(kv mail sent | tail -1)"
expect_in "$reply" "· $thread ·" "the reminder left the invoice's thread"
expect_in "$reply" "inReplyTo $newest" "the reminder doesn't answer the thread's newest mail"
pass "fact for the owner only; reminder sent once as a reply in thread $thread"
