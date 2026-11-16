#!/usr/bin/env bash
# Zoya suggests a change to a playbook from the doc: her chat with the team agent opens with the doc and a starter line.
source "$(dirname "$0")/lib.sh"
DOC="$(kv db "select key from kin_records where register_id = 'docs' and title = 'Chasing money' limit 1" | tail -1)"
[[ "$DOC" == D-* ]] || fail "no Chasing money playbook in the seed"
kv as zoya web open "docs?doc=$DOC" >/dev/null
kv as zoya web click --name "Doc actions" >/dev/null
kv as zoya web wait "Suggest a change" >/dev/null || fail "the playbook offers Zoya no way to suggest a change"
expect_not_in "$(kv as zoya web snapshot)" "Change this" "Zoya is offered the owner's Change this"
kv as zoya web click --name "Suggest a change" --role menuitem >/dev/null
kv as zoya web wait "Chief of staff" >/dev/null || fail "Suggest a change didn't open the team agent's chat"
composer="$(kv as zoya web snapshot --full)"
expect_in "$composer" "Say what you'd change in Chasing money. The owner decides." "the composer doesn't say the owner decides"
expect_in "$composer" "I'd like to suggest a change to Chasing money:" "the chat has no starter line"
kv as zoya web type --name "Message Chief of staff" "I'd like to suggest a change to Chasing money: start chasing after 10 days, not 15 ($RUN)" --enter >/dev/null
kv as zoya web wait "($RUN)" >/dev/null || fail "the suggestion didn't send"
refs="$(kv db "select refs_json from kin_messages where body like '%($RUN)%' limit 1" | tail -1)"
expect_in "$refs" "\"key\":\"$DOC\"" "the suggestion doesn't carry the doc"
pass "Zoya's suggestion on $DOC went to the team agent with the doc attached"
