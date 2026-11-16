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
[[ ${#SCRIPTS[@]} -eq 0 ]] && SCRIPTS=(assign-member-sees relay-owner-to-member member-request-to-owner
  private-task-hidden member-no-money send-card-once overdue-invoice-reminder checkin-new-agent
  lead-adds-milestone owner-money-forms private-client-unnamed told-once-quiet-hours
  team-room-discussion character-and-undo github-delegated-task work-change-five-people
  member-attaches-file github-events)
trap 'kv down >/dev/null' EXIT
started=$SECONDS
kv up --fresh || exit 1
failed=0
for name in "${SCRIPTS[@]}"; do
  at=$SECONDS
  if KIN_VERIFY_INSTANCE="$INSTANCE" bash "$HERE/$name.sh"; then result=passed; else
    result=failed
    failed=$((failed + 1))
  fi
  echo "     $name $result in $((SECONDS - at))s"
done
echo "run-all: $(( ${#SCRIPTS[@]} - failed ))/${#SCRIPTS[@]} passed in $((SECONDS - started))s"
[[ $failed -eq 0 ]]
