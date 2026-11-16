#!/usr/bin/env bash
# Updates the Kin server from source. Run as the kin user on the Kin host:
#
#   ~/t3code/ops/kin/host/update.sh
#
# Fetches `kin` into the clone, builds it in its own worktree (~/kin-builds/<sha>): install,
# the server's Kin contract tests, build. Only when all of that passes does it stop the server,
# back up its database, point ~/kin-current at the new build and start it. The running build is
# never touched. If the new build isn't healthy (up, answering, migrated), it goes back to the
# previous build, and to the backup when the new build had migrated the database.
# Keeps the 3 newest builds and the 10 newest update backups. Also does the first install.
#
# Sourcing this file defines its functions and runs nothing (scripts/kin-update.test.ts).

KEEP_BUILDS=3
KEEP_BACKUPS=10
ENV_FILE="$HOME/.config/kin/kin-server.env"
UNIT_DIR="$HOME/.config/systemd/user"
CURRENT="$HOME/kin-current"
BUILDS="$HOME/kin-builds"
DB="$HOME/.t3/userdata/statev2.sqlite"
BACKUP_DIR="${KIN_UPDATE_BACKUPS:-$HOME/kin-update-backups}"
SERVICE_ENV="$HOME/.t3/service.env"
# Seconds to wait for a new build to answer and finish its migrations.
ANSWER_TIMEOUT=90
BACKUP=""

say() { echo "update.sh: $*" >&2; }

# Highest migration id in a build's source: the T3 ones (NNN_Name.ts) and Kin's (KNNN_Name.ts).
build_heads() {
  local t3 kin
  t3="$(ls "$1/apps/server/src/persistence/Migrations" | sed -n 's/^0*\([0-9][0-9]*\)_.*\.ts$/\1/p' | sort -n | tail -n1)"
  kin="$(ls "$1/apps/server/src/kin/persistence/migrations" | sed -n 's/^K0*\([0-9][0-9]*\)_.*\.ts$/\1/p' | sort -n | tail -n1)"
  echo "${t3:-0} ${kin:-0}"
}

# The same two heads as the database records them; 0 for a table that isn't there yet.
db_heads() {
  local t3 kin
  [ -f "$DB" ] || { echo "0 0"; return; }
  t3="$(sqlite3 -readonly "$DB" 'SELECT coalesce(max(migration_id), 0) FROM effect_sql_migrations;' 2>/dev/null || echo 0)"
  kin="$(sqlite3 -readonly "$DB" 'SELECT coalesce(max(migration_id), 0) FROM kin_sql_migrations;' 2>/dev/null || echo 0)"
  echo "${t3:-0} ${kin:-0}"
}

# A consistent copy of the database before the new build migrates it. Sets BACKUP.
backup_db() {
  BACKUP=""
  [ -f "$DB" ] || return 0
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/statev2-$stamp-${1:0:12}.sqlite"
  (umask 077 && sqlite3 -readonly "$DB" ".backup '$BACKUP'") || { say "couldn't back up $DB to $BACKUP."; return 1; }
  [ "$(sqlite3 -readonly "$BACKUP" 'PRAGMA quick_check;')" = ok ] || { say "the backup $BACKUP failed its integrity check."; return 1; }
  say "backed up the database to $BACKUP."
}

# Keeps the newest KEEP_BACKUPS update backups. Only files this script named are touched.
prune_backups() {
  [ -d "$BACKUP_DIR" ] || return 0
  ls -1 "$BACKUP_DIR" | { grep -E '^statev2-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+\.sqlite$' || true; } | sort -r |
    tail -n +$((KEEP_BACKUPS + 1)) | while IFS= read -r name; do rm -f "$BACKUP_DIR/$name"; done
}

server_url() {
  local port=""
  if [ -f "$SERVICE_ENV" ]; then port="$(sed -n 's/^ *\(export \)\{0,1\}T3CODE_PORT=["'\'']\{0,1\}\([0-9]*\).*/\2/p' "$SERVICE_ENV" | tail -n1)"; fi
  echo "http://127.0.0.1:${port:-3773}"
}

# Empty when the running build is healthy; otherwise one line saying what isn't.
health() {
  local build="$1" state restarts url waited=0 want got
  # A build that crashes on boot still reads "active" right after restart; Restart=always hides it.
  sleep 15
  # systemctl show prints properties in its own order, so read them one at a time.
  state="$(systemctl --user show -P ActiveState kin-server)"
  restarts="$(systemctl --user show -P NRestarts kin-server)"
  if [ "$state" != active ] || [ "$restarts" != 0 ]; then
    echo "it didn't stay up (ActiveState=$state NRestarts=$restarts)"
    return
  fi
  url="$(server_url)"
  until curl -sS -o /dev/null --max-time 5 "$url/" 2>/dev/null; do
    if [ "$waited" -ge "$ANSWER_TIMEOUT" ]; then
      echo "it didn't answer on $url within ${ANSWER_TIMEOUT}s"
      return
    fi
    sleep 5
    waited=$((waited + 5))
  done
  want="$(build_heads "$build")"
  got="$(db_heads)"
  if [ "${got% *}" -lt "${want% *}" ] || [ "${got#* }" -lt "${want#* }" ]; then
    echo "the database is at migrations ${got% *}/K${got#* }, the build expects ${want% *}/K${want#* }"
    return
  fi
  restarts="$(systemctl --user show -P NRestarts kin-server)"
  [ "$restarts" = 0 ] || echo "it restarted while starting (NRestarts=$restarts)"
}

switch_to() {
  ln -sfn "$1" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
}

# The worker environment mounts ~/kin-current when it starts, so it moves to a build only on a
# restart. kin-worker.sh's sudoers entry lets kin run this; try-restart leaves a server Kin's
# pause stopped as it is. No worker unit, no restart.
restart_workers() {
  systemctl --system cat kin-worker-server.service >/dev/null 2>&1 || return 0
  sudo -n /usr/bin/systemctl try-restart kin-worker-server.service ||
    say "couldn't restart kin-worker-server, so workers still run the build before this one. Run sudo /root/kin-ops/ops/kin/host/kin-worker.sh."
}

# Puts back the backup taken before this update. The migrated database is kept beside it.
restore_db() {
  local sha="$1" kept="$DB.failed-${1:0:12}" ext
  for ext in "" -wal -shm; do
    if [ -e "$DB$ext" ]; then mv -f "$DB$ext" "$kept$ext"; fi
  done
  cp -p "$BACKUP" "$DB"
  say "restored the database from $BACKUP; the one $sha migrated is kept as $kept."
}

# Keep the newest complete builds, the running one and the previous one. Interrupted
# builds (no dist/bin.mjs) and builds that failed their health check take no slot and are removed.
prune_builds() {
  local build="$1" previous="$2" kept=1 dir
  if [ -n "$previous" ] && [ "$previous" != "$build" ]; then kept=2; fi
  while IFS= read -r dir; do
    dir="${dir%/}"
    if [ "$dir" = "$build" ] || [ "$dir" = "$previous" ]; then continue; fi
    if [ -f "$dir/apps/server/dist/bin.mjs" ] && [ ! -e "$dir/.failed" ] && [ "$kept" -lt "$KEEP_BUILDS" ]; then
      kept=$((kept + 1))
      continue
    fi
    git -C "$REPO" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
  done < <(ls -1dt "$BUILDS"/*/ 2>/dev/null)
  git -C "$REPO" worktree prune
}

write_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  rm -f "$ENV_FILE.prev"
  if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$ENV_FILE.prev"; fi
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  printf '%s\n' \
    "KIN_ENABLED=true" \
    "PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin" \
    "KIN_REPO=$REPO" \
    "KIN_CHECKOUT=$CURRENT" \
    "KIN_NODE_VERSION=$1" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

# From a finished build to a running one: stop, back up, switch, start, check, and go back on failure.
deploy() {
  local sha="$1" build="$2" previous="$3" node_version="$4" before problem unit
  before="$(db_heads)"
  # Stopped first, so the backup holds every write the previous build made.
  systemctl --user stop kin-server 2>/dev/null || true
  if ! backup_db "$sha"; then
    systemctl --user start kin-server || true
    say "nothing changed; the server runs ${previous:-nothing} again."
    return 1
  fi
  write_env_file "$node_version"
  mkdir -p "$UNIT_DIR"
  for unit in kin-server.service kin-backup.service kin-backup.timer; do
    cmp -s "$build/ops/kin/host/$unit" "$UNIT_DIR/$unit" ||
      install -m 0644 "$build/ops/kin/host/$unit" "$UNIT_DIR/$unit"
  done
  touch "$build"
  switch_to "$build"
  systemctl --user daemon-reload
  systemctl --user restart kin-server
  problem="$(health "$build")"
  if [ -z "$problem" ]; then
    rm -f "$ENV_FILE.prev"
    restart_workers
    say "running $sha, healthy: up, answering, migrations at $(db_heads | sed 's/ /\/K/'). Previous build: ${previous:-none}."
    prune_builds "$build" "$previous"
    prune_backups
    return 0
  fi

  say "$sha is not healthy: $problem."
  touch "$build/.failed"
  systemctl --user stop kin-server 2>/dev/null || true
  systemctl --user reset-failed kin-server 2>/dev/null || true
  if [ -n "$previous" ] && [ "$previous" != "$build" ] && [ -f "$previous/apps/server/dist/bin.mjs" ]; then
    # The previous build goes back with its own Node version, and its own schema when this one migrated.
    {
      if [ -f "$ENV_FILE.prev" ]; then mv -f "$ENV_FILE.prev" "$ENV_FILE"; fi
      if [ "$(db_heads)" != "$before" ] && [ -n "$BACKUP" ]; then restore_db "$sha"; fi
      switch_to "$previous"
      systemctl --user daemon-reload
    } || {
      say "rollback to $previous failed; see systemctl --user status kin-server"
      return 1
    }
    systemctl --user restart kin-server || {
      say "rollback restart failed; see systemctl --user status kin-server"
      return 1
    }
    restart_workers
    say "rolled back to $previous. $build is kept for inspection until the next good update."
  else
    # First install: nothing to go back to. Stop the crash loop so a rerun rebuilds.
    rm -f "$CURRENT"
    say "no previous build; kin-server is stopped. $build is kept for inspection."
  fi
  return 1
}

main() {
  set -euo pipefail
  [ "$(id -un)" = kin ] || { say "run this as kin, not $(id -un)."; exit 1; }
  # `sudo -iu kin` starts no user session, so point systemctl at kin's user manager.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

  # Read only KIN_REPO: sourcing the file would replace this shell's PATH with the unit's.
  local KIN_REPO=""
  if [ -f "$ENV_FILE" ]; then KIN_REPO="$(sed -n 's/^KIN_REPO=//p' "$ENV_FILE" | tail -n1)"; fi
  REPO="${KIN_REPO:-$HOME/t3code}"

  [ "$(git -C "$REPO" branch --show-current)" = kin ] || { say "$REPO is not on branch kin."; exit 1; }
  [ -f "$REPO/.env" ] || { say "$REPO/.env is missing (cp .env.example .env)."; exit 1; }

  git -C "$REPO" fetch origin +refs/heads/kin:refs/remotes/origin/kin
  git -C "$REPO" merge --ff-only origin/kin
  SHA="$(git -C "$REPO" rev-parse --verify 'HEAD^{commit}')"
  BUILD="$BUILDS/$SHA"
  PREVIOUS="$(readlink "$CURRENT" 2>/dev/null || true)"

  if [ "$PREVIOUS" = "$BUILD" ] && [ -f "$BUILD/apps/server/dist/bin.mjs" ]; then
    say "already running $SHA."
    exit 0
  fi

  mkdir -p "$BUILDS"
  if [ -e "$BUILD" ]; then git -C "$REPO" worktree remove --force "$BUILD" 2>/dev/null || rm -rf "$BUILD"; fi
  git -C "$REPO" worktree prune
  git -C "$REPO" worktree add --detach "$BUILD" "$SHA"
  trap 'say "build of $SHA failed; the server still runs ${PREVIOUS:-nothing}."; git -C "$REPO" worktree remove --force "$BUILD" 2>/dev/null || rm -rf "$BUILD"' ERR
  # Workers' sandbox mounts the build read-only, .env included, so it may hold only the public
  # identifiers .env.example names; a secret there would be readable by every worker.
  local allowed extra node_version lib
  allowed="$(sed -n 's/^#\{0,1\} *\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$BUILD/.env.example" | sort -u)"
  extra="$(sed -n 's/^ *\(export \)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' "$REPO/.env" | sort -u |
    comm -23 - <(printf '%s\n' "$allowed") | tr '\n' ' ')"
  if [ -n "$extra" ]; then
    say "$REPO/.env sets ${extra}which .env.example doesn't name. Workers can read the build's .env, so remove them; server settings go in ~/.t3/service.env."
    false
  fi
  cp -p "$REPO/.env" "$BUILD/.env"

  node_version="$(sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' "$BUILD/package.json" | head -n1)"
  [ -n "$node_version" ] || { say "no engines.node in package.json."; false; }
  mise install "node@$node_version"
  # Workers run kin's vp read-only from a home of their own, so vp can't use the system Node there
  # and can't download its own; give it the build's Node now.
  mise exec "node@$node_version" -- vp env install "$node_version" </dev/null

  cd "$BUILD"
  # Unattended, like scripts/setup-worktree.ts: a stale lockfile must fail, not be rewritten.
  mise exec "node@$node_version" -- vp i --frozen-lockfile -- --yes </dev/null
  (cd apps/server && mise exec "node@$node_version" -- vp test run kin-contract)
  mise exec "node@$node_version" -- vp run build:desktop
  [ -f apps/server/dist/bin.mjs ] || { say "the build wrote no apps/server/dist/bin.mjs."; false; }
  for lib in echarts mermaid d3; do
    [ -f "apps/server/dist/visual-lib/$lib.js" ] || { say "the build wrote no apps/server/dist/visual-lib/$lib.js, so visuals would draw without it."; false; }
  done
  trap - ERR

  deploy "$SHA" "$BUILD" "$PREVIOUS" "$node_version"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
