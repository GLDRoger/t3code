#!/usr/bin/env bash
# A task Finance holds in P-1 reads "Finance" to Zoya, who can't message Finance: in her Tasks, its sheet's history and the "Who has it" filter, never "An agent".
source "$(dirname "$0")/lib.sh"
TITLE="Reconcile clinics $RUN"
FINANCE="$(kv people | awk -F'\t' '$1=="finance"{print $3}')"
kv as owner rpc kin.work.create "{\"clientRequestId\":\"$SCRIPT-$RUN\",\"title\":\"$TITLE\",\"project\":\"P-1\",\"owner\":{\"_tag\":\"agent\",\"agentId\":\"$FINANCE\"}}" >/dev/null
kv as zoya web open tasks >/dev/null
kv as zoya web wait "$TITLE" >/dev/null || fail "Zoya never saw Finance's task"
list="$(kv as zoya web snapshot --full)"
expect_in "$list" "$TITLE. Finance" "Zoya's row doesn't name Finance"
expect_not_in "$list" "An agent" "Zoya's Tasks says 'An agent'"
kv as zoya web click --name "Filter" >/dev/null
expect_in "$(kv as zoya web snapshot --full)" "Finance" "the Who has it filter doesn't list Finance"
key="$(kv as zoya rpc kin.work.list '{"open":true}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).records.find(x=>x.title==='$TITLE');process.stdout.write(r?r.key:'')})")"
kv as zoya web open "tasks?task=$key" >/dev/null
kv as zoya web wait "gave this to Finance" >/dev/null || fail "Zoya's sheet doesn't say who it was given to"
expect_not_in "$(kv as zoya web snapshot --full)" "An agent" "Zoya's sheet says 'An agent'"
# Messaging stays as the owner set it: Finance isn't among her chats.
kv as zoya web open home >/dev/null
expect_not_in "$(kv as zoya web snapshot)" 'link "Finance' "Zoya can message Finance"
pass "Zoya reads Finance's name on its task, in the filter and the history, and still can't message it"
