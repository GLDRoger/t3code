#!/usr/bin/env bash
# Zoya messages Arjun from New: one chat, opened again the same; only the two of them read it, and it says so.
# Sent in Arjun's quiet hours, her message still rings his phone: a teammate is a person, not Kin.
source "$(dirname "$0")/lib.sh"
ARJUN="$(kv people | awk '$1 == "arjun" { print $NF }')"
ZOYA="$(kv people | awk '$1 == "zoya" { print $NF }')"
json() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$1" "$2"; }
chat="$(json "$(kv as zoya rpc kin.chats.withPerson "{\"personId\":\"$ARJUN\"}")" chatId)"
[[ "$(json "$(kv as arjun rpc kin.chats.withPerson "{\"personId\":\"$ZOYA\"}")" chatId)" == "$chat" ]] ||
  fail "Arjun's way in opened a second chat"
# 23:00 on Arjun's clock, so he is in his quiet hours (Etc/GMT-N is UTC+N).
ARJUN_ZONE="$(kv db "select time_zone from kin_people where person_id = '$ARJUN'" | tail -1)"
trap 'kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ARJUN\",\"timeZone\":\"$ARJUN_ZONE\"}" >/dev/null' EXIT
NIGHT="$(node -e 'let n=((23-new Date().getUTCHours())%24+24)%24;if(n>14)n-=24;process.stdout.write(n===0?"Etc/GMT":`Etc/GMT${n>0?"-":"+"}${Math.abs(n)}`)')"
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ARJUN\",\"timeZone\":\"$NIGHT\"}" >/dev/null
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update("arjun-"+process.argv[1]).digest("hex"))' "$RUN")"
kv as arjun rpc kin.push.registerDevice "{\"token\":\"$TOKEN\",\"platform\":\"ios\",\"apsEnvironment\":\"development\"}" >/dev/null
# Lines he wrote in the last ten minutes would let Kin's line through: put them out of reach.
kv clock advance 11m >/dev/null
# Kin's own line to him waits for morning, so these are his quiet hours.
relay="{\"to\":\"Arjun Rao\",\"text\":\"Proof $RUN: the van comes at nine.\"}"
expect_in "$(kv tool chief kin_relay "$relay" --as-turn-of owner)" "their time" \
  "Arjun isn't in his quiet hours, so the ring below proves nothing"
kv as zoya rpc kin.messages.send "{\"chatId\":\"$chat\",\"clientMessageId\":\"pair-$RUN\",\"body\":\"Lunch at one? $RUN\"}" >/dev/null
for _ in $(seq 1 20); do
  kv push sent | rg -F "/${TOKEN:0:6}" | rg -qF "Lunch at one? $RUN" && break
  sleep 1
done
expect_in "$(kv push sent | rg -F "/${TOKEN:0:6}" | rg -F "Lunch at one? $RUN" || true)" "Lunch at one? $RUN" \
  "Zoya's message didn't ring Arjun's phone in his quiet hours"
page="{\"chatId\":\"$chat\",\"beforeSeq\":100000,\"limit\":50}"
expect_in "$(kv as arjun rpc kin.chat.history "$page")" "Lunch at one? $RUN" "Arjun can't read Zoya's message"
for person in owner meera dev; do
  expect_in "$(kv as "$person" rpc kin.chat.history "$page" 2>&1 || true)" "not_found" "$person reads their chat"
done
expect_in "$(kv as zoya rpc kin.chats.withPerson "{\"personId\":\"$ZOYA\"}" 2>&1 || true)" "invalid_state" "Zoya opened a chat with herself"
# On the web: New offers it, and the chat names the only two readers.
kv as zoya web open chat:chief >/dev/null
kv as zoya web click --name "New chat, group, agent or teammate" >/dev/null
kv as zoya web click --name "Message someone" >/dev/null
kv as zoya web wait "Only you and they can read it." >/dev/null || fail "the picker doesn't say who reads the chat"
kv as zoya web click --name "Arjun Rao" >/dev/null
kv as zoya web wait "Only you two can read this." >/dev/null || fail "the chat doesn't say only the two of them read it"
expect_in "$(kv as zoya web snapshot --full)" "Lunch at one? $RUN" "the picker opened another chat"
pass "Zoya and Arjun share one chat; owner, Meera and Dev can't read it; the chat says so; it rang Arjun at 23:00 while Kin's line waited"
