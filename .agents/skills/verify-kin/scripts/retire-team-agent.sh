#!/usr/bin/env bash
# Chief of staff is the team agent. Retiring it without naming who the team talks to instead is
# refused, so nobody is left writing to an agent that never answers. On the web, its page's Retire
# asks "Who should the team talk to instead?"; with Finance picked, Finance is the team agent and
# Zoya's list has Finance where Chief of staff was. Restoring Chief of staff and picking it again
# puts the team back as it was.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
CHIEF="$(q "select agent_id from kin_leads where name = 'Chief of staff'")"
FIN="$(q "select agent_id from kin_leads where name = 'Finance'")"
team() { q "select agent_id from kin_team_agents"; }
zoya_agents() { kv as zoya rpc kin.leads.list '{}'; }
[[ "$(team)" == "$CHIEF" ]] || fail "Chief of staff isn't the team agent to start with"
expect_in "$(zoya_agents)" "\"name\":\"Chief of staff\"" "Zoya can't reach the team agent to start with"

out="$(kv as owner rpc kin.lead.retire "{\"agentId\":\"$CHIEF\"}" 2>&1 || true)"
expect_in "$out" "Choose who they should talk to instead" "retiring the team agent alone wasn't refused: $out"
[[ "$(q "select coalesce(retired_at, 'live') from kin_agents where agent_id = '$CHIEF'")" == live ]] ||
  fail "the refused retire retired Chief of staff anyway"
out="$(kv as zoya rpc kin.lead.retire "{\"agentId\":\"$CHIEF\",\"nextTeamAgentId\":\"$FIN\"}" 2>&1 || true)"
[[ "$(team)" == "$CHIEF" ]] || fail "Zoya changed the team agent: $out"

kv as owner web open "/kin?settings=agents" >/dev/null
kv as owner web click --name "Chief of staff" --role link >/dev/null ||
  fail "Settings → Agents has no Chief of staff to open"
kv as owner web click --name "Retire agent" >/dev/null || fail "Chief of staff's page has no Retire agent"
kv as owner web wait "Who should the team talk to instead?" >/dev/null ||
  fail "retiring the team agent didn't ask who the team talks to instead"
kv as owner web click --name "Choose an agent" >/dev/null || fail "the picker can't be opened"
kv as owner web click --name "Finance" --role menuitemradio >/dev/null || fail "Finance isn't offered"
kv as owner web click --name "Retire agent" --within "Retire Chief of staff?" >/dev/null ||
  fail "the confirm's Retire agent can't be clicked"
for _ in $(seq 1 20); do
  [[ "$(team)" == "$FIN" ]] && break
  sleep 1
done
[[ "$(team)" == "$FIN" ]] || fail "Finance didn't become the team agent"
[[ "$(q "select coalesce(retired_at, 'live') from kin_agents where agent_id = '$CHIEF'")" != live ]] ||
  fail "Chief of staff wasn't retired"
agents="$(zoya_agents)"
expect_in "$agents" "\"name\":\"Finance\"" "Zoya's list doesn't have Finance to talk to"
expect_not_in "$agents" "\"name\":\"Chief of staff\"" "Zoya's list still has the retired Chief of staff"

# The way back: restore Chief of staff and make it the team agent again.
kv as owner rpc kin.lead.restore "{\"agentId\":\"$CHIEF\"}" >/dev/null || fail "restore refused"
kv as owner rpc kin.org.setTeamAgent "{\"agentId\":\"$CHIEF\"}" >/dev/null || fail "setting it back refused"
[[ "$(team)" == "$CHIEF" ]] || fail "Chief of staff isn't the team agent again"
expect_in "$(zoya_agents)" "\"name\":\"Chief of staff\"" "Zoya can't reach Chief of staff again"
pass "retiring the team agent alone was refused; on the web it asked who the team talks to instead, Finance took over for Zoya; restoring and picking Chief of staff put it back"
