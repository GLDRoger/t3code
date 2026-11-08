#!/usr/bin/env bash
# Updates the Kin server from source. Run as the kin user on the Kin host:
#
#   ~/t3code/ops/kin/host/update.sh
#
# Fetches `kin` into the clone, builds it in its own worktree (~/kin-builds/<sha>): install,
# the server's Kin contract tests, build. Only when all of that passes does it point
# ~/kin-current at the new build and restart. The running build is never touched.
# Keeps the 3 newest builds for rollback. Also does the first install.
set -euo pipefail

KEEP_BUILDS=3
ENV_FILE="$HOME/.config/kin/kin-server.env"
UNIT_DIR="$HOME/.config/systemd/user"
CURRENT="$HOME/kin-current"
BUILDS="$HOME/kin-builds"

[ "$(id -un)" = kin ] || { echo "update.sh: run this as kin, not $(id -un)." >&2; exit 1; }
# `sudo -iu kin` starts no user session, so point systemctl at kin's user manager.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

# Read only KIN_REPO: sourcing the file would replace this shell's PATH with the unit's.
KIN_REPO=""
if [ -f "$ENV_FILE" ]; then KIN_REPO="$(sed -n 's/^KIN_REPO=//p' "$ENV_FILE" | tail -n1)"; fi
REPO="${KIN_REPO:-$HOME/t3code}"

[ "$(git -C "$REPO" branch --show-current)" = kin ] || {
  echo "update.sh: $REPO is not on branch kin." >&2
  exit 1
}
[ -f "$REPO/.env" ] || { echo "update.sh: $REPO/.env is missing (cp .env.example .env)." >&2; exit 1; }

git -C "$REPO" fetch origin +refs/heads/kin:refs/remotes/origin/kin
git -C "$REPO" merge --ff-only origin/kin
SHA="$(git -C "$REPO" rev-parse --verify 'HEAD^{commit}')"
BUILD="$BUILDS/$SHA"
PREVIOUS="$(readlink "$CURRENT" 2>/dev/null || true)"

if [ "$PREVIOUS" = "$BUILD" ] && [ -f "$BUILD/apps/server/dist/bin.mjs" ]; then
  echo "update.sh: already running $SHA."
  exit 0
fi

mkdir -p "$BUILDS"
if [ -e "$BUILD" ]; then git -C "$REPO" worktree remove --force "$BUILD" 2>/dev/null || rm -rf "$BUILD"; fi
git -C "$REPO" worktree prune
git -C "$REPO" worktree add --detach "$BUILD" "$SHA"
trap 'echo "update.sh: build of $SHA failed; the server still runs ${PREVIOUS:-nothing}." >&2; git -C "$REPO" worktree remove --force "$BUILD" 2>/dev/null || rm -rf "$BUILD"' ERR
cp -p "$REPO/.env" "$BUILD/.env"

node_version="$(sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' "$BUILD/package.json" | head -n1)"
[ -n "$node_version" ] || { echo "update.sh: no engines.node in package.json." >&2; false; }
mise install "node@$node_version"

cd "$BUILD"
# Unattended, like scripts/setup-worktree.ts: a stale lockfile must fail, not be rewritten.
mise exec "node@$node_version" -- vp i --frozen-lockfile -- --yes </dev/null
(cd apps/server && mise exec "node@$node_version" -- vp test run kin-contract)
mise exec "node@$node_version" -- vp run build:desktop
[ -f apps/server/dist/bin.mjs ] || { echo "update.sh: the build wrote no apps/server/dist/bin.mjs." >&2; false; }
trap - ERR

mkdir -p "$(dirname "$ENV_FILE")" "$UNIT_DIR"
rm -f "$ENV_FILE.prev"
if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$ENV_FILE.prev"; fi
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
printf '%s\n' \
  "KIN_ENABLED=true" \
  "PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin" \
  "KIN_REPO=$REPO" \
  "KIN_CHECKOUT=$CURRENT" \
  "KIN_NODE_VERSION=$node_version" >"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$ENV_FILE"

for unit in kin-server.service kin-backup.service kin-backup.timer; do
  cmp -s "ops/kin/host/$unit" "$UNIT_DIR/$unit" ||
    install -m 0644 "ops/kin/host/$unit" "$UNIT_DIR/$unit"
done

touch "$BUILD"
ln -sfn "$BUILD" "$CURRENT.new"
mv -T "$CURRENT.new" "$CURRENT"
systemctl --user daemon-reload
systemctl --user restart kin-server
# A build that crashes on boot still reads "active" right after restart; Restart=always hides it.
sleep 15
# systemctl show prints properties in its own order, so read them one at a time.
state="$(systemctl --user show -P ActiveState kin-server)"
restarts="$(systemctl --user show -P NRestarts kin-server)"
if [ "$state" != active ] || [ "$restarts" != 0 ]; then
  echo "update.sh: $SHA didn't stay up (ActiveState=$state NRestarts=$restarts)." >&2
  touch "$BUILD/.failed"
  systemctl --user reset-failed kin-server 2>/dev/null || true
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$BUILD" ] && [ -f "$PREVIOUS/apps/server/dist/bin.mjs" ]; then
    # The previous build goes back with its own Node version.
    {
      if [ -f "$ENV_FILE.prev" ]; then mv -f "$ENV_FILE.prev" "$ENV_FILE"; fi
      ln -sfn "$PREVIOUS" "$CURRENT.new"
      mv -T "$CURRENT.new" "$CURRENT"
      systemctl --user daemon-reload
    } || {
      echo "update.sh: rollback to $PREVIOUS failed; see systemctl --user status kin-server" >&2
      exit 1
    }
    systemctl --user restart kin-server || {
      echo "update.sh: rollback restart failed; see systemctl --user status kin-server" >&2
      exit 1
    }
    echo "update.sh: rolled back to $PREVIOUS. $BUILD is kept for inspection until the next good update." >&2
  else
    # First install: nothing to go back to. Stop the crash loop so a rerun rebuilds.
    systemctl --user stop kin-server || true
    rm -f "$CURRENT"
    echo "update.sh: no previous build; kin-server is stopped. $BUILD is kept for inspection." >&2
  fi
  exit 1
fi
rm -f "$ENV_FILE.prev"
echo "update.sh: running $SHA. Previous build: ${PREVIOUS:-none}."

# Keep the newest complete builds, the running one and the previous one. Interrupted
# builds (no dist/bin.mjs) and builds that failed their health check take no slot and are removed.
kept=1
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$BUILD" ]; then kept=2; fi
while IFS= read -r dir; do
  if [ "$dir" = "$BUILD" ] || [ "$dir" = "$PREVIOUS" ]; then continue; fi
  if [ -f "$dir/apps/server/dist/bin.mjs" ] && [ ! -e "$dir/.failed" ] && [ "$kept" -lt "$KEEP_BUILDS" ]; then
    kept=$((kept + 1))
    continue
  fi
  git -C "$REPO" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
done < <(stat -c '%.9Y %n' "$BUILDS"/*/ | sort -rn | cut -d' ' -f2- | sed 's:/$::')
git -C "$REPO" worktree prune
