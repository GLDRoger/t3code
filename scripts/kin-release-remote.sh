#!/usr/bin/env bash
# The second machine's side of `kin-release-check.ts` with KIN_RELEASE_REMOTE set: checks out
# <commit> in this checkout, installs, runs the release check with the rest of the arguments, and
# prints its findings and summary between markers for the machine that asked.
#   bash scripts/kin-release-remote.sh <commit> [release-check args…]
# Exits 75 when another run holds this checkout, 76 when the commit can't be fetched, 77 when the
# install fails: the asking machine then runs the check itself.
set -uo pipefail

# A function, parsed whole before it runs: the checkout below may change this very file.
main() {
  local root commit lock pid mode dir code
  root="$(cd "$(dirname "$0")/.." && pwd)"
  commit=$1
  shift
  lock="$root/.t3/release-check.lock"
  mkdir -p "$root/.t3"
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "kin-release-remote: busy with another run (pid $pid)"
      return 75
    fi
    rm -rf "$lock"
    mkdir "$lock" || return 75
  fi
  echo $$ >"$lock/pid"
  trap 'rm -rf "'"$lock"'"' EXIT
  cd "$root" || return 76
  git fetch -q origin "$commit" && git checkout -q --detach "$commit" || {
    echo "kin-release-remote: can't fetch $commit here; push it first"
    return 76
  }
  vp i >/dev/null 2>&1 || {
    echo "kin-release-remote: vp i failed on $commit"
    return 77
  }
  mode=quick
  [[ " $* " == *" --full "* ]] && mode=full
  dir="${KIN_RELEASE_CHECK_DIR:-$HOME/.cache/kin-release-check}/${commit:0:12}/$mode"
  node scripts/kin-release-check.ts "$@" --out "$dir"
  code=$?
  echo "@@kin-release-findings"
  cat "$dir/findings.json"
  echo "@@kin-release-summary"
  cat "$dir/summary.md"
  echo "@@kin-release-end"
  return "$code"
}
main "$@"
exit $?
