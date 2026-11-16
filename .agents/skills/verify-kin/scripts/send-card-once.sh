#!/usr/bin/env bash
# Finance proposes an email; the owner's Confirm sends exactly one; a second confirm sends nothing.
source "$(dirname "$0")/lib.sh"
SUBJECT="Proof $RUN: invoice INV/26-27/004 from Ambermill"
kv tool finance kin_document '{"entry":"INV-1","recipe":"invoice","title":"Invoice INV/26-27/004"}' >/dev/null
before="$(sent_count)"
OUT="$(kv tool finance kin_connection_call "{\"connection\":\"hello@ambermill.example\",\"tool\":\"mail_send\",\"arguments\":{\"to\":[\"anita@orbitdental.example\"],\"subject\":\"$SUBJECT\",\"body\":\"Hi Anita, the retainer invoice is attached. Rhea\",\"attachments\":[\"INV-1\"]},\"reason\":\"owner asked to send the invoice\"}")"
expect_in "$OUT" "Nothing was sent" "the call didn't wait for the owner: $OUT"
[[ "$(sent_count)" == "$before" ]] || fail "mail went out before the owner confirmed"
kv as owner web open chat:finance >/dev/null
kv as owner web wait "$SUBJECT" >/dev/null || fail "no card in the owner's chat"
kv as owner web click --name Confirm --within "$SUBJECT" >/dev/null
[[ "$(sent_count)" == "$((before + 1))" ]] || fail "Confirm sent $(($(sent_count) - before)) mails, not 1"
expect_in "$(kv mail sent | tail -1)" "$SUBJECT" "the newest sent mail isn't this one"
card="$(card_id "$SUBJECT")"
again="$(kv as owner rpc kin.widgets.act "{\"widgetId\":\"$card\",\"revision\":$(card_revision "$card"),\"actionId\":\"choose\",\"value\":\"option-1\",\"clientActionId\":\"second-$RUN\"}" 2>&1 || true)"
[[ "$(sent_count)" == "$((before + 1))" ]] || fail "a second confirm sent again ($again)"
pass "one Confirm sent one mail; the second confirm was refused: ${again#kin-verify: }"
