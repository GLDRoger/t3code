#!/usr/bin/env bash
# Cold start, every lifecycle script, then down whatever happened. Exits non-zero if any failed.
# Usage: run-all.sh [--instance <name>] [--queue <dir>] [script-name ...]
#        run-all.sh --list
# With --queue, several run-all.sh, each on its own instance, share the scripts in <dir>/todo
# (files named <order>-<script>): each takes the next one left, so they finish together.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
INSTANCE=default
QUEUE=
# told-once-quiet-hours goes first: a relay to someone who just wrote answers them and never waits.
ALL=(told-once-quiet-hours assign-member-sees relay-owner-to-member
  member-request-to-owner private-task-hidden member-no-money send-card-once overdue-invoice-reminder
  checkin-new-agent lead-adds-milestone owner-money-forms private-client-unnamed team-room-discussion
  character-and-undo github-delegated-task work-change-five-people member-attaches-file agent-page
  project-people-loop member-sees-agent-name lead-undoes-only-me open-questions github-events github-protect-branch
  member-messages-teammate member-refused-client member-suggests-playbook quote-invoice-loop
  social-week
  hours-two-zones relay-marked asker-is-giver remove-and-bring-back teammate-reminder
  money-place-follows away-held hand-over-all teammate-request-routed retire-team-agent
  batch-all-or-nothing decision-found-again late-task-told promise-kept)
if [[ "${1:-}" == "--list" ]]; then printf '%s\n' "${ALL[@]}"; exit 0; fi
if [[ "${1:-}" == "--instance" ]]; then INSTANCE=$2; shift 2; fi
if [[ "${1:-}" == "--queue" ]]; then QUEUE=$2; shift 2; fi
kv() { node "$ROOT/scripts/kin-verify.ts" --instance "$INSTANCE" "$@"; }
SCRIPTS=("$@")
[[ ${#SCRIPTS[@]} -eq 0 ]] && SCRIPTS=("${ALL[@]}")
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
# The next script: from the list, or the first file in the queue this run renames to itself.
next() {
  if [[ -z "$QUEUE" ]]; then
    ((index < ${#SCRIPTS[@]})) || return 1
    name="${SCRIPTS[index]}"
    index=$((index + 1))
    return 0
  fi
  local file
  for file in "$QUEUE"/todo/*; do
    [[ -e "$file" ]] || return 1
    mv "$file" "$QUEUE/taken/$INSTANCE-${file##*/}" 2>/dev/null || continue
    name="${file##*/}"
    name="${name#*-}"
    return 0
  done
  return 1
}
trap 'kv down >/dev/null' EXIT
started=$SECONDS
kv up --fresh || exit 1
[[ -n "$QUEUE" ]] && mkdir -p "$QUEUE/taken"
index=0
ran=0
failed=0
while next; do
  at=$SECONDS
  midday
  if KIN_VERIFY_INSTANCE="$INSTANCE" bash "$HERE/$name.sh"; then result=passed; else
    result=failed
    failed=$((failed + 1))
  fi
  ran=$((ran + 1))
  echo "     $name $result in $((SECONDS - at))s"
done
echo "run-all: $((ran - failed))/$ran passed in $((SECONDS - started))s"
[[ $failed -eq 0 ]]
