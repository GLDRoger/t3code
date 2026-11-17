#!/usr/bin/env bash
# Cold start, every lifecycle script, then down whatever happened. Exits non-zero if any failed.
# Usage: run-all.sh [--instance <name>] [script-name ...]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
INSTANCE=default
if [[ "${1:-}" == "--instance" ]]; then INSTANCE=$2; shift 2; fi
kv() { node "$ROOT/scripts/kin-verify.ts" --instance "$INSTANCE" "$@"; }
SCRIPTS=("$@")
# told-once-quiet-hours goes first: a relay to someone who just wrote answers them and never waits.
[[ ${#SCRIPTS[@]} -eq 0 ]] && SCRIPTS=(told-once-quiet-hours assign-member-sees relay-owner-to-member
  member-request-to-owner private-task-hidden member-no-money send-card-once overdue-invoice-reminder
  checkin-new-agent lead-adds-milestone owner-money-forms private-client-unnamed team-room-discussion
  character-and-undo github-delegated-task work-change-five-people member-attaches-file agent-page
  project-people-loop member-sees-agent-name lead-undoes-only-me open-questions github-events
  member-messages-teammate member-refused-client member-suggests-playbook quote-invoice-loop
  social-week
  hours-two-zones relay-marked asker-is-giver remove-and-bring-back teammate-reminder away-held
  hand-over-all)
# Midday on everyone's clock before each script, so the hour it runs at holds nothing back;
# scripts about hours set their own zones. Etc/GMT-N is UTC+N.
midday() {
  local zone ids
  zone="$(node -e 'const h=new Date().getUTCHours();let n=((12-h)%24+24)%24;if(n>14)n-=24;process.stdout.write(n===0?"Etc/GMT":`Etc/GMT${n>0?"-":"+"}${Math.abs(n)}`)')"
  ids="$(kv db "select person_id from kin_people where removed_at is null" | tail -n +2)"
  for id in $ids; do
    kv as owner rpc kin.people.updateProfile "{\"personId\":\"$id\",\"timeZone\":\"$zone\"}" >/dev/null
  done
  kv as owner rpc kin.triggers.setTimeZone "{\"timeZone\":\"$zone\"}" >/dev/null
}
trap 'kv down >/dev/null' EXIT
started=$SECONDS
kv up --fresh || exit 1
failed=0
for name in "${SCRIPTS[@]}"; do
  at=$SECONDS
  midday
  if KIN_VERIFY_INSTANCE="$INSTANCE" bash "$HERE/$name.sh"; then result=passed; else
    result=failed
    failed=$((failed + 1))
  fi
  echo "     $name $result in $((SECONDS - at))s"
done
echo "run-all: $(( ${#SCRIPTS[@]} - failed ))/${#SCRIPTS[@]} passed in $((SECONDS - started))s"
[[ $failed -eq 0 ]]
