# Sourced by the lifecycle scripts: the driver, a run token, and plain assertions.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SCRIPT="$(basename "$0" .sh)"
# Unique per run, so a script can run again on the same instance.
RUN="$(node -e 'process.stdout.write(Date.now().toString(36).slice(-6))')"
kv() { node "$ROOT/scripts/kin-verify.ts" "$@"; }
fail() {
  echo "FAIL $SCRIPT: $*" >&2
  exit 1
}
pass() { echo "ok   $SCRIPT: $*"; }
contains() { [[ "$1" == *"$2"* ]]; }
expect_in() { contains "$1" "$2" || fail "$3 (expected \"$2\")"; }
expect_not_in() { contains "$1" "$2" && fail "$3 (found \"$2\")" || true; }
sent_count() { kv mail sent | head -1 | cut -d' ' -f1; }
# The widget id of the newest card whose content mentions $1.
card_id() { kv db "select widget_id from kin_widgets where state_json like '%$1%' order by updated_at desc limit 1" | tail -1; }
card_revision() { kv db "select revision from kin_widgets where widget_id = '$1'" | tail -1; }
