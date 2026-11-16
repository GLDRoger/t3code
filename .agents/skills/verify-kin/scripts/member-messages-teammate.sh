#!/usr/bin/env bash
# Zoya messages Arjun from New: one chat, opened again the same; only the two of them read it, and it says so.
source "$(dirname "$0")/lib.sh"
ARJUN="$(kv people | awk '$1 == "arjun" { print $NF }')"
ZOYA="$(kv people | awk '$1 == "zoya" { print $NF }')"
json() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$1" "$2"; }
chat="$(json "$(kv as zoya rpc kin.chats.withPerson "{\"personId\":\"$ARJUN\"}")" chatId)"
[[ "$(json "$(kv as arjun rpc kin.chats.withPerson "{\"personId\":\"$ZOYA\"}")" chatId)" == "$chat" ]] ||
  fail "Arjun's way in opened a second chat"
kv as zoya rpc kin.messages.send "{\"chatId\":\"$chat\",\"clientMessageId\":\"pair-$RUN\",\"body\":\"Lunch at one? $RUN\"}" >/dev/null
page="{\"chatId\":\"$chat\",\"beforeSeq\":100000,\"limit\":50}"
expect_in "$(kv as arjun rpc kin.chat.history "$page")" "Lunch at one? $RUN" "Arjun can't read Zoya's message"
for person in owner meera dev; do
  expect_in "$(kv as "$person" rpc kin.chat.history "$page" 2>&1 || true)" "not_found" "$person reads their chat"
done
expect_in "$(kv as zoya rpc kin.chats.withPerson "{\"personId\":\"$ZOYA\"}" 2>&1 || true)" "invalid_state" "Zoya opened a chat with herself"
# On the web: New offers it, and the chat names the only two readers.
kv as zoya web open chat:chief >/dev/null
kv as zoya web click --name "New chat, group, agent or teammate" >/dev/null
kv as zoya web click --name "Message a teammate" >/dev/null
kv as zoya web wait "Only you and they can read it." >/dev/null || fail "the picker doesn't say who reads the chat"
kv as zoya web click --name "Arjun Rao" >/dev/null
kv as zoya web wait "Only you and Arjun Rao can read this." >/dev/null || fail "the chat doesn't say only the two of them read it"
expect_in "$(kv as zoya web snapshot --full)" "Lunch at one? $RUN" "the picker opened another chat"
pass "Zoya and Arjun share one chat; owner, Meera and Dev can't read it; the chat says so"
