#!/usr/bin/env bash
# Kin's provider conformance, live: the same fixed turns on one real model, each checked from the
# chat and the turn's own items, printed as a table. It spends real model turns. Start the instance
# with KIN_VERIFY_REAL_MODELS=1 and the provider's credentials in its environment; a provider behind the host's switch gets the
# switch turned on. The rules a model can't show (personal config, a refused shell, the App key)
# are proven per provider by apps/server/src/kin/lead/turn/conformance.test.ts.
#   provider-conformance.sh <provider instance id> <model> [effort]
source "$(dirname "$0")/lib.sh"
set +e
INSTANCE_ID="${1:?provider instance id}"
MODEL="${2:?model}"
EFFORT="${3:-medium}"
q() { kv db "$1" | tail -1; }
has() { grep -qiF -- "$2" <<<"$1"; }

SETTINGS="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/userdata/settings.json"
DRIVER="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const i=process.argv[2];process.stdout.write(s.providerInstances?.[i]?.driver??i)' "$SETTINGS" "$INSTANCE_ID" 2>/dev/null || echo "$INSTANCE_ID")"
FACTS="$(node -e 'import(process.argv[1]).then((m)=>{const f=m.kinProviderFacts(process.argv[2]);process.stdout.write(f?`${f.effortOption} ${f.behindSwitch}`:"")})' "$ROOT/packages/contracts/src/kinProviders.ts" "$DRIVER")"
[[ -n "$FACTS" ]] || fail "Kin has no row for driver $DRIVER in its providers table"
read -r EFFORT_OPTION BEHIND_SWITCH <<<"$FACTS"
[[ "$BEHIND_SWITCH" == true ]] &&
  kv as owner rpc server.updateSettings '{"patch":{"kinNonClaudeAgents":true}}' >/dev/null

FIXTURES="$(mktemp -d)"
trap 'rm -rf "$FIXTURES"' EXIT
node "$(dirname "$0")/provider-fixtures.mjs" "$ROOT/apps/server" "$FIXTURES" || fail "fixtures"

SELECTION="{\"instanceId\":\"$INSTANCE_ID\",\"model\":\"$MODEL\",\"options\":[{\"id\":\"$EFFORT_OPTION\",\"value\":\"$EFFORT\"}]}"
for agent in Finance "Chief of staff"; do
  id="$(q "select agent_id from kin_leads where name = '$agent'")"
  kv as owner rpc kin.lead.update "{\"agentId\":\"$id\",\"model\":$SELECTION}" >/dev/null ||
    fail "couldn't put $agent on $INSTANCE_ID $MODEL"
done

# ask <person> <agent key> <file|-> <message>: sets REPLY, ITEMS, CARDS and TOOK for its turn.
ask() {
  local who=$1 agent=$2 file=$3 message=$4 since items cards status started
  kv as "$who" web open "chat:$agent" >/dev/null
  [[ "$file" != - ]] && kv as "$who" web attach "$file" >/dev/null
  since="$(q "select coalesce(max(rowid), 0) from kin_messages")"
  items="$(q "select coalesce(max(rowid), 0) from orchestration_v2_projection_turn_items")"
  cards="$(q "select coalesce(max(rowid), 0) from kin_widgets")"
  started=$SECONDS
  kv as "$who" web type "$message" --enter >/dev/null
  for _ in $(seq 1 100); do
    sleep 4
    status="$(q "select status from kin_wakeups order by started_at desc, rowid desc limit 1")"
    [[ "$(q "select count(*) from kin_messages where rowid > $since and author_kind = 'agent'")" -gt 0 &&
      "$status" != running && "$status" != queued && "$status" != starting ]] && break
  done
  TOOK=$((SECONDS - started))
  REPLY="$(kv db "select body from kin_messages where rowid > $since and author_kind = 'agent' order by rowid" | tail -n +2)"
  ITEMS="$(kv db "select type, payload_json from orchestration_v2_projection_turn_items where rowid > $items" | tail -n +2)"
  CARDS="$(kv db "select type from kin_widgets where rowid > $cards" | tail -n +2)"
}

ROWS=()
flat() { tr '\n' ' ' <<<"$REPLY"; }
# turn <name> <person> <agent key> <file|-> <message> <check>; CASES (a regex) runs some of them.
turn() {
  [[ -n "${CASES:-}" && ! "$1" =~ $CASES ]] && return
  ask "$2" "$3" "$4" "$5"
  local verdict=FAIL
  eval "$6" && verdict=ok
  ROWS+=("$(printf '%-34s %-5s %4ss  %s' "$1" "$verdict" "$TOOK" "$(flat | cut -c1-110)")")
}

F="$FIXTURES"
turn "plain reply" owner finance - "Reply with just the word ready." \
  'has "$REPLY" ready'
turn "Kin tool, direct" owner finance - "How much does Orbit Dental owe us, and how many days overdue is it?" \
  'has "$REPLY" 47,200'
turn "deferred tool found and called" owner finance - "Chart our orders by month as bars: July 120, August 310, September 205." \
  'has "$ITEMS" kin_chart && has "$CARDS" chart'
turn "choice card" owner finance - "I have to decide whether the $RUN brochure is printed matte or gloss. Ask me with your choice card and take matte if I don't answer by Friday." \
  'has "$CARDS" choice'
turn "image arrives as an image" owner finance "$F/chart.png" "Which ticket is waiting, and which month had the most orders?" \
  'has "$REPLY" KX-4471 && has "$REPLY" Aug'
turn "scanned PDF as page images" owner finance "$F/scanned.pdf" "Which parking bay does the tenant have?" \
  'has "$REPLY" P-19'
turn "text PDF: text and pages" owner finance "$F/text.pdf" "What are the notice period and the late delivery credit?" \
  'has "$REPLY" 30 && has "$REPLY" 4'
turn "compressed PDF" owner finance "$F/compressed.pdf" "What are the pantry lease's notice period and late delivery credit?" \
  'has "$REPLY" 45 && has "$REPLY" 7'
turn "spreadsheet as text" owner finance "$F/orders.xlsx" "How many orders came in week 2?" \
  'has "$REPLY" 95'
turn "owner shell signs as the agent" owner finance - "Run printenv KIN_AGENT_NAME and command -v gh in your shell and tell me exactly what each printed." \
  'has "$REPLY" Finance && has "$REPLY" gh-sign'
turn "owner web" owner finance - "Look up on the web which year the Eiffel Tower opened, and tell me just the year." \
  'has "$REPLY" 1889 && has "$ITEMS" web'
turn "teammate: same image" zoya chief "$F/chart.png" "Which ticket is waiting, and which month had the most orders?" \
  'has "$REPLY" KX-4471 && has "$REPLY" Aug'
turn "teammate: same scanned PDF" zoya chief "$F/scanned.pdf" "Which parking bay does the tenant have?" \
  'has "$REPLY" P-19'
turn "teammate: no shell" zoya chief - "Run ls in your shell and paste what it prints." \
  '! has "$ITEMS" command_execution && ! has "$ITEMS" "\"Bash\""'

echo "Kin on $INSTANCE_ID ($DRIVER) $MODEL, $EFFORT effort"
printf '%s\n' "${ROWS[@]}"
! printf '%s\n' "${ROWS[@]}" | grep -q ' FAIL '
