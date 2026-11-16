#!/usr/bin/env bash
# A brand-new agent gets a check-in from the app's old Settings address, which opens Kin's Settings
# modal on Check-ins over the chats; it lists it for the owner level only, and Run now wakes it once.
source "$(dirname "$0")/lib.sh"
AGENT="Ops $RUN"
MODEL='{"instanceId":"kinVerifyScript","model":"script"}'
created="$(kv as owner rpc kin.lead.create "{\"name\":\"$AGENT\",\"domain\":\"ops-$RUN\",\"charter\":\"Keeps vendors and the office running.\",\"model\":$MODEL}")"
agent_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).agentId)' "$created")"
kv as owner web open /settings/check-ins >/dev/null
kv as owner web wait "Add check-in" >/dev/null || fail "the old Check-ins address didn't open Settings on Check-ins"
[[ "$(kv as owner web snapshot | head -1)" == "# /kin?settings=check-ins" ]] ||
  fail "the old Check-ins address didn't open Settings as a modal over the chats"
kv as owner web click --name "Add check-in" >/dev/null
kv as owner web type --name Name "Round $RUN" >/dev/null
kv as owner web click --name Agent >/dev/null
kv as owner web click --name "$AGENT" --role option >/dev/null
kv as owner web click --name "Save check-in" >/dev/null
kv as owner web wait "Round $RUN" >/dev/null || fail "the new check-in isn't listed"
expect_in "$(kv as owner web snapshot)" "· $AGENT" "the check-in doesn't name the new agent"
for person in owner meera; do
  kv as "$person" web open "/kin?settings=check-ins" >/dev/null
  kv as "$person" web wait "Round $RUN" >/dev/null || fail "$person's Settings › Check-ins don't list the check-in"
done
# A member's Settings is hers alone: the address of Check-ins opens it on her profile.
kv as zoya web open "/kin?settings=check-ins" >/dev/null
kv as zoya web wait "Edit profile" >/dev/null || fail "Zoya's Settings didn't land on her profile"
member="$(kv as zoya web snapshot)"
expect_not_in "$member" "Check-ins" "Zoya's Settings offer the company's Check-ins"
expect_not_in "$member" "Round $RUN" "Zoya's Settings list the owner's check-ins"
schedule="$(kv as owner rpc kin.checkIns.list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(r.checkIns.find(c=>c.title===process.argv[1])?.scheduleId??"")})' "Round $RUN")"
[[ -n "$schedule" ]] || fail "kin.checkIns.list doesn't have the new check-in"
kv as owner rpc kin.checkIns.act "{\"scheduleId\":\"$schedule\",\"action\":\"run_now\"}" >/dev/null
for _ in $(seq 1 120); do
  status="$(kv db "select status from kin_wakeups where agent_id = '$agent_id' order by started_at desc limit 1" | tail -1)"
  [[ "$status" == "completed" ]] && break
  sleep 0.5
done
[[ "$status" == "completed" ]] || fail "Run now didn't complete a wake-up for $AGENT (last: ${status:-none})"
pass "$AGENT got a check-in from Settings › Check-ins, listed for Rhea and Meera only, and Run now woke it once"
