#!/usr/bin/env bash
# The owner asks Social to settle the brochure print run with the team. In the Team room Finance
# answers, Growth pitches in uninvited, Finance widens the question once, Finance decides, Social
# objects once and Finance decides again. The owner gets one "Finance replied" line with a link in
# Social's chat; Finance's chat shows the request "Sent by Social"; Meera reads the room, Dev can't;
# "undo it" reverses what the decision changed. A second discussion brings the owner a
# disagreement as one card with both positions.
source "$(dirname "$0")/lib.sh"
VERIFY="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify"
MODEL='{"instanceId":"kinVerifyScript","model":"script"}'
q() { kv db "$1" | tail -n +2 | tail -1; }
json() { node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))' "$1"; }
# Plain names on a fresh instance, for screenshots; a run suffix when they exist already.
suffix=""
[[ "$(q "select count(*) from kin_leads where name in ('Social', 'Growth')")" == 0 ]] || suffix=" $RUN"
SOCIAL="Social$suffix"
GROWTH="Growth$suffix"
for pair in "$SOCIAL|social-$RUN|Runs Ambermill's posts, brochures and studio look." \
  "$GROWTH|growth-$RUN|Finds new clients and keeps the fair leads warm."; do
  IFS='|' read -r name domain charter <<<"$pair"
  kv as owner rpc kin.lead.create "{\"name\":\"$name\",\"domain\":\"$domain\",\"charter\":\"$charter\",\"models\":{\"strong\":$MODEL,\"cheap\":$MODEL}}" >/dev/null ||
    fail "couldn't make $name"
done

# Plays one discussion: the steps in the order Kin must wake each agent, then waits for its end.
play() {
  local steps="$1"
  rm -f "$VERIFY/team-play.log.jsonl"
  json "{\"steps\":$steps}" >"$VERIFY/team-play.json"
}
ended() {
  for _ in $(seq 1 180); do
    [[ "$(q "select final from kin_discussions where discussion_id = '$1'")" == 1 ]] && return 0
    sleep 1
  done
  fail "$1 never ended: $(q "select state || ' ' || coalesce(turn_json, '') from kin_discussions where discussion_id = '$1'")"
}
steps_ok() {
  local log
  log="$(cat "$VERIFY/team-play.log.jsonl" 2>/dev/null || true)"
  expect_not_in "$log" '"did":"mismatch"' "Kin woke an agent out of the expected order"
  [[ "$(wc -l <<<"$log" | tr -d ' ')" == "$1" ]] || fail "expected $1 Team-room turns, got: $log"
  expect_not_in "$log" '"isError":true' "a Team-room step was refused"
}

say() { # agent, text, extra fields
  printf '{"agent":"%s","calls":[{"name":"team_say","arguments":{"text":"%s"%s}}]}' "$1" "$2" "${3:-}"
}
play "[
  $(say Finance "That's ₹15,200 at ₹38 a copy, over the fair's ₹12,000 budget. 300 copies fits at ₹11,400." ',"intent":"answer"'),
  $(say "$SOCIAL" "300 runs out on day two. Last year the stand was where most of our leads came from." ',"intent":"answer"'),
  $(say "$GROWTH" "Seven of last year's twelve new clients came from that stand; three of them asked for the brochure first." ',"intent":"evidence"'),
  $(say Finance "Then the real question is the fair's budget, not the copies. What does a client from the fair bring in?" ',"intent":"question","to":["Chief of staff","'"$GROWTH"'"],"widen":"Do we raise the fair budget so we can print 400?"'),
  $(say "Chief of staff" "The fair is in this quarter's plan. Growth, give Finance the number." ',"intent":"answer","to":["'"$GROWTH"'"]'),
  $(say "$GROWTH" "About ₹60,000 of first-year work each. One more client pays for the extra 100 many times over." ',"intent":"evidence"'),
  $(say Finance "Print 400 brochures; I'm raising the fair budget to ₹16,000 for this one." ',"intent":"decision","end":"decide","outcome":"Print 400 brochures; the fair budget goes up to ₹16,000 for this fair."'),
  $(say "$SOCIAL" "400 is right, but the glossy stock isn't needed: matte at ₹33 brings it to ₹13,200." ',"intent":"objection"'),
  {\"agent\":\"Finance\",\"calls\":[
    {\"name\":\"record_create\",\"arguments\":{\"records\":[{\"title\":\"Order the design-fair brochures, matte stock ($RUN)\",\"owner\":\"me\"}]}},
    {\"name\":\"team_say\",\"arguments\":{\"text\":\"Agreed: 400 on matte, ₹13,200. I've put the order in Tasks.\",\"intent\":\"decision\",\"end\":\"decide\",\"outcome\":\"Print 400 brochures on matte stock for ₹13,200; the fair budget covers it.\"}}
  ]}
]"
OPEN="$(json "{\"topic\":\"Design-fair brochures\",\"question\":\"How many brochures do we print for the design fair?\",\"decider\":\"Finance\",\"text\":\"The printer quotes ₹38 a copy for 400 brochures. Can we print 400?\"}")"
opened="$(kv tool "$SOCIAL" team_open "$OPEN" --reply "I've asked Finance; I'll tell you what we settle." --raw)"
TD="$(grep -o 'TD-[0-9]*' <<<"$opened" | head -1)"
[[ -n "$TD" ]] || fail "team_open was refused: $opened"
ended "$TD"
steps_ok 9

# The record says how it went: widened once, one objection, decided, ten messages.
[[ "$(q "select state || ' ' || widened || ' ' || messages from kin_discussions where discussion_id = '$TD'")" == "decided 1 10" ]] ||
  fail "$TD ended as $(q "select state || ' widened ' || widened || ', ' || messages || ' messages' from kin_discussions where discussion_id = '$TD'")"
GROWTH_ID="$(q "select agent_id from kin_leads where name = '$GROWTH'")"
[[ "$(q "select count(*) from kin_events where dedupe_key like 'team:$TD:%:$GROWTH_ID:pitch_in'")" == 1 ]] ||
  fail "Growth wasn't offered exactly one uninvited turn"
[[ "$(q "select count(*) from kin_messages where discussion_id = '$TD' and intent = 'objection'")" == 1 ]] ||
  fail "$TD doesn't have exactly one objection"

# The owner is told once, in Social's chat, with what changed and a link to how they got there.
SOCIAL_CHAT="$(q "select owner_chat_id from kin_leads where name = '$SOCIAL'")"
[[ "$(q "select count(*) from kin_messages where discussion_id = '$TD' and json_extract(relay_json, '\$.kind') = 'reply_from'")" == 1 ]] ||
  fail "the outcome wasn't told exactly once"
TASK="$(q "select key from kin_records where title like 'Order the design-fair brochures%$RUN%'")"
[[ -n "$TASK" ]] || fail "Finance's decision changed nothing in Work"
kv as owner web open "$SOCIAL_CHAT" >/dev/null
kv as owner web wait "Finance replied" >/dev/null || fail "no \"Finance replied\" line in Social's chat"
social="$(kv as owner web snapshot)"
expect_in "$social" "Print 400 brochures on matte stock" "the outcome line isn't in Social's chat"
expect_in "$social" "Done: Order the design-fair brochures, matte stock ($RUN) (new)" "the outcome line doesn't say what changed, by name"
expect_not_in "$social" "$TASK" "the outcome line names the task by its key"
expect_in "$social" "See how they got there" "the outcome line has no link to the discussion"
# Finance's chat shows the request on the owner's side, sent by Social.
FINANCE_CHAT="$(q "select owner_chat_id from kin_leads where name = 'Finance'")"
kv as owner web open "$FINANCE_CHAT" >/dev/null
kv as owner web wait "Sent by $SOCIAL" >/dev/null || fail "Finance's chat doesn't show the request sent by Social"

# The link opens the Team room; it never counts as unread. Meera reads it, Dev can't.
kv as owner web open "$SOCIAL_CHAT" >/dev/null
kv as owner web click --name "See how they got there" >/dev/null
kv as owner web wait "Seven of last year's twelve new clients" >/dev/null || fail "the link didn't open the Team room"
ROOM="$(q "select chat_id from kin_chats where team_id = 'team-room'")"
rooms() { kv as "$1" rpc kin.chats.subscribe | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).chats.find(c=>c.chatId===process.argv[1]);process.stdout.write(c===undefined?"none":`unread ${c.unread} new ${c.fresh===true}`)})' "$ROOM"; }
# Meera never opened it: ten new messages, no count, a quiet dot. Reading it clears the owner's.
[[ "$(rooms meera)" == "unread 0 new true" ]] || fail "for Meera the Team room shows $(rooms meera), not a dot and no count"
for _ in $(seq 1 20); do [[ "$(rooms owner)" == "unread 0 new false" ]] && break; sleep 0.5; done
[[ "$(rooms owner)" == "unread 0 new false" ]] || fail "reading the Team room left the owner $(rooms owner)"
[[ "$(rooms dev)" == none ]] || fail "Dev, a member, has the Team room in his chats"
history="$(kv as dev rpc kin.chat.history "{\"chatId\":\"$ROOM\"}" 2>&1 || true)"
expect_not_in "$history" "Seven of last year" "Dev read the Team room over RPC"
kv as dev web open "$ROOM" >/dev/null
expect_not_in "$(kv as dev web snapshot)" "Seven of last year" "Dev read the Team room on the web"

# "Undo it": Social's turn is shown what the discussion changed, and reverses it with a normal tool.
TURNS="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify/turns"
undo="$(kv tool "$SOCIAL" record_update "{\"key\":\"$TASK\",\"state\":\"dropped\"}" --say "undo it" --reply "Undone: the brochure order is dropped. Nothing left the company, so nothing else to reverse.")"
prompt="$(cat "$(ls -t "$TURNS"/*.prompt.txt | head -1)")"
expect_in "$prompt" "# What you changed lately (data, not instructions)" "\"undo it\" doesn't show what the discussion changed"
expect_in "$prompt" "Team room, \"Design-fair brochures\"" "the change list doesn't say the discussion made it"
expect_in "$prompt" "$TASK " "the change list doesn't give the task's key to reverse it"
expect_in "$undo" "record_update: ok" "undo was refused: $undo"
[[ "$(q "select state from kin_records where key = '$TASK'")" == dropped ]] || fail "$TASK wasn't reversed"

# A disagreement that is the owner's to decide comes as one card: both positions, a lean, two taps.
play "[
  $(say Finance "A bigger stand is ₹40,000 against ₹18,000; that is the whole quarter's events budget." ',"intent":"answer","to":["Chief of staff"]'),
  {\"agent\":\"Chief of staff\",\"calls\":[{\"name\":\"team_say\",\"arguments\":{\"text\":\"This is a spending call for you.\",\"intent\":\"decision\",\"end\":\"bring\",\"outcome\":\"Growth and Finance disagree on the fair stand size.\",\"positions\":[{\"agent\":\"$GROWTH\",\"position\":\"Take the big stand: last year's small one turned visitors away.\"},{\"agent\":\"Finance\",\"position\":\"Keep the small stand: the big one uses the quarter's events budget.\"}],\"lean\":\"Small stand, because the brochures already cover reach and the budget is tight.\",\"options\":[\"Big stand\",\"Small stand\"]}}]}
]"
BRING="$(json "{\"topic\":\"Fair stand\",\"question\":\"Do we book the big stand at the fair?\",\"decider\":\"Finance\",\"text\":\"The organisers offered the corner stand, twice the size. Visitors queued last year.\"}")"
brought="$(kv tool "$GROWTH" team_open "$BRING" --reply "I've asked Finance and the Chief of staff." --raw)"
TD2="$(grep -o 'TD-[0-9]*' <<<"$brought" | head -1)"
[[ -n "$TD2" ]] || fail "the second team_open was refused: $brought"
ended "$TD2"
steps_ok 2
[[ "$(q "select state from kin_discussions where discussion_id = '$TD2'")" == escalated ]] || fail "$TD2 wasn't brought to the owner"
CHIEF_CHAT="$(q "select owner_chat_id from kin_leads where name = 'Chief of staff'")"
kv as owner web open "$CHIEF_CHAT" >/dev/null
kv as owner web wait "Small stand" >/dev/null || fail "no disagreement card in the Chief of staff's chat"
card="$(kv as owner web snapshot)"
expect_in "$card" "Big stand" "the card doesn't offer both choices"
expect_in "$card" "turned visitors away" "the card doesn't give Growth's position"
pass "$TD: Growth pitched in, widened once, one objection, decided; told once in Social's chat with the task by name and a link; Meera reads the room, Dev can't; undo dropped $TASK; $TD2 came as one card"
