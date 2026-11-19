#!/usr/bin/env bash
# Updates the Kin server from source. Run as the kin user on the Kin host:
#
#   ~/t3code/ops/kin/host/update.sh
#
# Fetches `kin` into the clone, builds it in its own worktree (~/kin-builds/<sha>): install,
# the server's Kin contract tests, Kin's name on the web app, build. Only when all of that passes
# does it stop the server, back up its database, point ~/kin-current at the new build and start
# it. The running build is never touched. If the new build isn't healthy (up, answering,
# migrated), it goes back to the previous build, and to the backup when the new build had
# migrated the database.
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
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SELF_SUM="$(cksum <"$SELF")"

say() { echo "update.sh: $*" >&2; }

# This shell read the script before the merge, so a change to it would wait for the update after
# this one. Run the merged script instead, once.
hand_over() {
  local merged="$REPO/ops/kin/host/update.sh"
  if [ -n "${KIN_UPDATE_HANDED_OVER:-}" ] || [ "$(cksum <"$merged")" = "$SELF_SUM" ]; then return 0; fi
  say "the update script changed; running the new one."
  KIN_UPDATE_HANDED_OVER=1 exec bash "$merged" "$@"
}

# `sudo -iu kin` starts no user session, so point systemctl at kin's user manager.
user_bus() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
}
# What a stopped server's message tells the owner to run, from any kin shell.
STATUS="XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status kin-server"

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
  ln -sfn "$1" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"
}

# Puts back the backup taken before this update; the migrated database is kept beside it as
# $DB.failed-<sha>. Every step is checked: on failure it puts back what it moved and returns 1.
# Sets MIGRATED to where the migrated database is afterwards.
restore_db() {
  local sha="$1" kept="$DB.failed-${1:0:12}" tmp="$DB.restoring" ext moved=()
  MIGRATED="$DB"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  # Copied and checked beside the database first, so a failed copy changes nothing.
  if ! cp -p "$BACKUP" "$tmp" ||
    [ "$(wc -c <"$tmp")" != "$(wc -c <"$BACKUP")" ] ||
    [ "$(sqlite3 -readonly "$tmp" 'PRAGMA quick_check;' 2>/dev/null)" != ok ]; then
    rm -f "$tmp" "$tmp-wal" "$tmp-shm"
    say "couldn't copy $BACKUP to $tmp intact, so the database was left as $sha migrated it."
    return 1
  fi
  rm -f "$tmp-wal" "$tmp-shm"
  # The migrated database's -wal and -shm go with it: a stale WAL beside the restored file would be replayed into it.
  for ext in "" -wal -shm; do
    [ -e "$DB$ext" ] || continue
    if mv -f "$DB$ext" "$kept$ext"; then moved+=("$ext"); else
      put_back "$kept" ${moved[@]+"${moved[@]}"}
      rm -f "$tmp"
      say "couldn't move $DB$ext aside."
      return 1
    fi
  done
  if ! mv -f "$tmp" "$DB"; then
    put_back "$kept" ${moved[@]+"${moved[@]}"}
    say "couldn't rename $tmp to $DB."
    return 1
  fi
  MIGRATED="$kept"
  say "restored the database from $BACKUP; the one $sha migrated is kept as $kept."
}

# put_back <kept> <ext...>: moves the migrated database's files back to $DB. Sets MIGRATED.
put_back() {
  local kept="$1" ext
  shift
  MIGRATED="$DB"
  for ext in "$@"; do mv -f "$kept$ext" "$DB$ext" || MIGRATED="$kept"; done
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

# Keeps the file it replaces as $ENV_FILE.prev. Returns 1 on any failed step, with $ENV_FILE untouched.
write_env_file() {
  local tmp
  mkdir -p "$(dirname "$ENV_FILE")" || return 1
  rm -f "$ENV_FILE.prev"
  if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$ENV_FILE.prev" || { rm -f "$ENV_FILE.prev"; return 1; }; fi
  tmp="$(mktemp "$ENV_FILE.XXXXXX")" || return 1
  if ! printf '%s\n' \
    "KIN_ENABLED=true" \
    "PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin" \
    "KIN_REPO=$REPO" \
    "KIN_CHECKOUT=$CURRENT" \
    "KIN_NODE_VERSION=$1" \
    ${2:+"KIN_BUILD_COMMIT=$2"} >"$tmp" || ! chmod 600 "$tmp" || ! mv -f "$tmp" "$ENV_FILE"; then
    rm -f "$tmp"
    return 1
  fi
}

install_units() {
  local unit
  mkdir -p "$UNIT_DIR" || return 1
  for unit in kin-server.service kin-backup.service kin-backup.timer; do
    cmp -s "$1/ops/kin/host/$unit" "$UNIT_DIR/$unit" ||
      install -m 0644 "$1/ops/kin/host/$unit" "$UNIT_DIR/$unit" || return 1
  done
}

# Back to the previous build's env file, units and link after a failure. Returns 1 if any step fails.
restore_previous() {
  local previous="$1" ok=0
  if [ -f "$ENV_FILE.prev" ]; then mv -f "$ENV_FILE.prev" "$ENV_FILE" || ok=1; fi
  install_units "$previous" || ok=1
  switch_to "$previous" || ok=1
  systemctl --user daemon-reload || ok=1
  return "$ok"
}

# From a finished build to a running one: stop, back up, switch, start, check, and go back on failure.
# Every way out ends with one update.sh: line saying what runs now.
deploy() {
  local sha="$1" build="$2" previous="$3" node_version="$4" before problem
  local has_previous=""
  if [ -n "$previous" ] && [ "$previous" != "$build" ] && [ -f "$previous/apps/server/dist/bin.mjs" ]; then has_previous=1; fi
  before="$(db_heads)"
  # Stopped first, so the backup holds every write the previous build made.
  systemctl --user stop kin-server 2>/dev/null || true
  if ! backup_db "$sha"; then
    systemctl --user start kin-server || true
    say "nothing changed; the server runs ${previous:-nothing} again."
    return 1
  fi
  # Nothing has touched the database yet, so a failure here only needs the previous files and a start.
  if ! { write_env_file "$node_version" "${PUBLISHED:-}" && install_units "$build" && touch "$build" && switch_to "$build" &&
    systemctl --user daemon-reload; }; then
    say "couldn't switch to $sha (env file, units or link); the database is untouched."
    if [ -z "$has_previous" ]; then
      rm -f "$CURRENT"
      say "no previous build; kin-server is stopped."
    elif restore_previous "$previous" && systemctl --user start kin-server; then
      say "the server runs $previous again."
    else
      say "couldn't put $previous back; kin-server is stopped. See $STATUS."
    fi
    return 1
  fi
  systemctl --user restart kin-server || true
  problem="$(health "$build")"
  if [ -z "$problem" ]; then
    rm -f "$ENV_FILE.prev"
    say "running $sha, healthy: up, answering, migrations at $(db_heads | sed 's/ /\/K/'). Previous build: ${previous:-none}."
    prune_builds "$build" "$previous"
    prune_backups
    return 0
  fi

  say "$sha is not healthy: $problem."
  touch "$build/.failed" || true
  systemctl --user stop kin-server 2>/dev/null || true
  systemctl --user reset-failed kin-server 2>/dev/null || true
  if [ -z "$has_previous" ]; then
    # First install: nothing to go back to. Stop the crash loop so a rerun rebuilds.
    rm -f "$CURRENT"
    say "no previous build; kin-server is stopped. $build is kept for inspection."
    return 1
  fi
  # The previous build goes back with its own Node version, and its own schema when this one migrated.
  if [ "$(db_heads)" != "$before" ] && [ -n "$BACKUP" ] && ! restore_db "$sha"; then
    # Down with its data intact beats up and empty: never start on a database we couldn't restore.
    # No link either, so a reboot can't start the previous build on the migrated database.
    restore_previous "$previous" || true
    rm -f "$CURRENT"
    say "ROLLBACK STOPPED: kin-server is NOT running and its data is intact. Good copy from before the update: $BACKUP. Database $sha migrated: $MIGRATED. Free disk space, then run: bash -c 'source \"\$1\" && user_bus && BACKUP=\"\$2\" && restore_db \"\$3\" && switch_to \"\$4\" && systemctl --user start kin-server' _ '$SELF' '$BACKUP' '$sha' '$previous'"
    return 1
  fi
  if ! restore_previous "$previous"; then
    say "rollback to $previous failed; kin-server is stopped. See $STATUS."
    return 1
  fi
  if ! systemctl --user restart kin-server; then
    say "rollback restart failed; kin-server is stopped. See $STATUS."
    return 1
  fi
  say "rolled back to $previous. $build is kept for inspection until the next good update."
  return 1
}

main() {
  set -euo pipefail
  [ "$(id -un)" = kin ] || { say "run this as kin, not $(id -un)."; exit 1; }
  user_bus

  # Read only KIN_REPO: sourcing the file would replace this shell's PATH with the unit's.
  local KIN_REPO=""
  if [ -f "$ENV_FILE" ]; then KIN_REPO="$(sed -n 's/^KIN_REPO=//p' "$ENV_FILE" | tail -n1)"; fi
  REPO="${KIN_REPO:-$HOME/t3code}"

  [ "$(git -C "$REPO" branch --show-current)" = kin ] || { say "$REPO is not on branch kin."; exit 1; }
  [ -f "$REPO/.env" ] || { say "$REPO/.env is missing (cp .env.example .env)."; exit 1; }

  git -C "$REPO" fetch origin +refs/heads/kin:refs/remotes/origin/kin
  git -C "$REPO" merge --ff-only origin/kin
  hand_over "$@"
  SHA="$(git -C "$REPO" rev-parse --verify 'HEAD^{commit}')"
  # The memory repo's memory-check fetches its pin from GitHub, so only a pushed commit is offered.
  PUBLISHED="$SHA"
  git -C "$REPO" merge-base --is-ancestor "$SHA" origin/kin || PUBLISHED=""
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
  # The build's .env may hold only the public identifiers .env.example names: anything that can
  # read the build can read it. Settings and secrets go in ~/.t3/service.env.
  local allowed extra node_version lib
  allowed="$(sed -n 's/^#\{0,1\} *\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$BUILD/.env.example" | sort -u)"
  extra="$(sed -n 's/^ *\(export \)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' "$REPO/.env" | sort -u |
    comm -23 - <(printf '%s\n' "$allowed") | tr '\n' ' ')"
  if [ -n "$extra" ]; then
    say "$REPO/.env sets ${extra}which .env.example doesn't name. The build's .env is for public identifiers only, so remove them; server settings go in ~/.t3/service.env."
    false
  fi
  cp -p "$REPO/.env" "$BUILD/.env"

  node_version="$(sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' "$BUILD/package.json" | head -n1)"
  [ -n "$node_version" ] || { say "no engines.node in package.json."; false; }
  mise install "node@$node_version"

  cd "$BUILD"
  # Unattended, like scripts/setup-worktree.ts: a stale lockfile must fail, not be rewritten.
  mise exec "node@$node_version" -- vp i --frozen-lockfile -- --yes </dev/null
  (cd apps/server && mise exec "node@$node_version" -- vp test run kin-contract)
  # The web app it serves is named Kin (scope web in branding/rules.yaml); the server stays T3's.
  mise exec "node@$node_version" -- node scripts/kin-brand.ts --scope web --in-place
  mise exec "node@$node_version" -- vp run build:desktop
  [ -f apps/server/dist/bin.mjs ] || { say "the build wrote no apps/server/dist/bin.mjs."; false; }
  for lib in echarts mermaid d3; do
    [ -f "apps/server/dist/visual-lib/$lib.js" ] || { say "the build wrote no apps/server/dist/visual-lib/$lib.js, so visuals would draw without it."; false; }
  done
  trap - ERR

  deploy "$SHA" "$BUILD" "$PREVIOUS" "$node_version"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
