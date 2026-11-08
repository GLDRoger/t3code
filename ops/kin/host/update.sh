#!/usr/bin/env bash
# Updates the Kin server from source. Run as the kin user on the Kin host:
#
#   ~/t3code/ops/kin/host/update.sh
#
# Pulls `kin`, installs, runs the server's Kin contract tests, builds, then restarts.
# A failure at any step leaves the running server untouched.
set -euo pipefail

CHECKOUT="${KIN_CHECKOUT:-$HOME/t3code}"
ENV_FILE="$HOME/.config/kin/kin-server.env"

[ "$(id -un)" = kin ] || { echo "update.sh: run this as kin, not $(id -un)." >&2; exit 1; }
[ "$(git -C "$CHECKOUT" branch --show-current)" = kin ] || {
  echo "update.sh: $CHECKOUT is not on branch kin." >&2
  exit 1
}

cd "$CHECKOUT"
git pull --ff-only
vp i
(cd apps/server && vp test run kin-contract)
vp run build:desktop

node_version="$(sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' package.json | head -n1)"
if [ -n "$node_version" ] && ! grep -qx "KIN_NODE_VERSION=$node_version" "$ENV_FILE" 2>/dev/null; then
  mise install "node@$node_version"
  mkdir -p "$(dirname "$ENV_FILE")"
  printf 'KIN_CHECKOUT=%s\nKIN_NODE_VERSION=%s\n' "$CHECKOUT" "$node_version" >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

for unit in kin-server.service kin-backup.service kin-backup.timer; do
  cmp -s "ops/kin/host/$unit" "$HOME/.config/systemd/user/$unit" ||
    install -m 0644 "ops/kin/host/$unit" "$HOME/.config/systemd/user/$unit"
done
systemctl --user daemon-reload
systemctl --user restart kin-server
systemctl --user is-active kin-server
