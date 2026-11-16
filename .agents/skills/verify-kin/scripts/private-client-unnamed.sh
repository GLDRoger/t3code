#!/usr/bin/env bash
# The owner marks C-3 private; in Zoya's turn, touch_log, record_get and records_query given its key or name answer as for no client, and its name reaches neither the tools nor her chat.
source "$(dirname "$0")/lib.sh"
CANARY="Canary $RUN Private Co"
rev="$(kv db "select rev from kin_records where key = 'C-3'" | tail -1)"
kv as owner rpc kin.work.updateParty "{\"key\":\"C-3\",\"rev\":$rev,\"name\":\"$CANARY\",\"sensitive\":true}" >/dev/null ||
  fail "the owner couldn't mark C-3 private"
log() {
  kv tool chief touch_log "{\"client\":\"$1\",\"kind\":\"call\",\"note\":\"Proof $RUN call\",\"sourceEventId\":\"\$event\"}" --as-turn-of zoya 2>&1 || true
}
hidden="$(log C-3)"
missing="$(log C-999)"
# By name, the answer repeats only what she typed, as for a name no client has.
byName="$(log "$CANARY")"
noName="$(log "Nobody $RUN Private Co")"
got="$(kv tool chief record_get '{"key":"C-3"}' --as-turn-of zoya 2>&1 || true)"
listed="$(kv tool chief records_query '{"list":"clients"}' --as-turn-of zoya 2>&1 || true)"
for out in "$hidden" "$missing" "$got" "$listed"; do
  expect_not_in "$out" "$CANARY" "a tool in Zoya's turn named the private client"
done
expect_in "$hidden" "No client called C-3" "touch_log on the private key didn't answer as for no client: $hidden"
[[ "${hidden//C-3/K}" == "${missing//C-999/K}" ]] ||
  fail "a private key answers unlike a missing one: '$hidden' vs '$missing'"
[[ "${byName//$CANARY/N}" == "${noName//Nobody $RUN Private Co/N}" ]] ||
  fail "the private client's name answers unlike a name no client has: '$byName' vs '$noName'"
expect_not_in "$listed" "C-3" "records_query listed the private client to Zoya"
# The tool still works for a client she sees.
seen="$(log C-1)"
expect_in "$seen" "touch_log: ok" "touch_log on a client Zoya sees was refused: $seen"
expect_not_in "$(kv db "select note from kin_client_touches t join kin_records r on r.record_id = t.party_id where r.key = 'C-3'")" \
  "Proof $RUN" "a contact was logged against the private client"
kv as zoya web open chat:chief >/dev/null
expect_not_in "$(kv as zoya web snapshot --full)" "$CANARY" "Zoya's chat names the private client"
pass "a private client's key and name reach no tool result or chat in Zoya's turn"
