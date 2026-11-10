#!/usr/bin/env bash
# Kin's worker environment: a plain T3 server as the `kin-worker` user, linked from kin-server.
# Workers' shells run there, in a sandbox that has no kin home, no owner home and no /tmp of
# kin's, so they can't read Kin's database, secrets, memory key or service.env, or run Kin's CLI.
#
#   sudo <root-owned clone>/ops/kin/host/kin-worker.sh setup [owner/repo ...]   everything, in
#                                            one go: asks for the worker's two credentials on
#                                            the terminal, and ends with `check`
#   sudo <root-owned clone>/ops/kin/host/kin-worker.sh [install] [--dry-run]   set up or repair
#   sudo kin-worker link                     (re)link kin-server; the timer runs it weekly
#   sudo kin-worker check                    the isolation checks, as a transcript
#   sudo kin-worker run [--] <command...>    a command as kin-worker, in the sandbox
#                                            (`t3 ...` runs Kin's build's CLI)
#
# kin-server reaches two more through its sudoers entry, and the worker unit a third:
#   kin-worker upload-pack <path>            the worker's repository, read-only, for Kin to publish
#   kin-worker may-start                     the unit's ExecCondition: no org of Kin's is paused
#
# `install` copies this script to /usr/local/sbin/kin-worker. Nothing here restarts kin-server.
# Root never writes, chowns or chmods through a path under the worker's home: that work runs as
# kin-worker (`worker_do`), so a symlink there reaches only what kin-worker could already change.
set -euo pipefail

KIN_USER=kin
WORKER_USER=kin-worker
KIN_HOME=/home/$KIN_USER
WORKER_HOME=/home/$WORKER_USER
KIN_PORT=3773
WORKER_PORT=3874
WORKER_URL=http://127.0.0.1:$WORKER_PORT
BUILD=/opt/kin-current
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS=(kin-worker-server.service kin-worker-link.service kin-worker-link.timer)
# Replaced by update.sh restarting the worker server itself; install removes them.
OLD_UNITS=(kin-worker-reload.path kin-worker-reload.service)
SUDOERS=/etc/sudoers.d/kin-worker
GATEWAY_KEY=$WORKER_HOME/.config/kin-worker/gateway-key
KIN_DB=$KIN_HOME/.t3/userdata/statev2.sqlite
WORKER_DB=$WORKER_HOME/.t3/userdata/statev2.sqlite
# The most of a worker's repository Kin's server reads in one publish.
UPLOAD_PACK_MAX_BYTES=$((512 * 1024 * 1024))
# The probes and helpers run these, never anything on the worker's PATH; `check` verifies each
# is root-owned and writable by no one else.
TRUSTED_BINS=(/usr/bin/python3 /usr/bin/sqlite3 /usr/bin/curl /usr/bin/git /usr/bin/setpriv
  /usr/bin/nsenter /usr/bin/getent /usr/bin/ss /usr/bin/env /bin/sh /bin/cat)
SYSTEM_PATH=/usr/bin:/bin
WORKER_PATH="$WORKER_HOME/.local/bin:$WORKER_HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin"
# Cloud metadata, link-local, Tailscale (CGNAT and ULA) and private LAN ranges. A worker needs
# none of them; allow one back with `IPAddressAllow=` in a drop-in (README, "Workers").
DENIED_NETWORKS="169.254.0.0/16 fe80::/10 100.64.0.0/10 fc00::/7 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
# The sandbox. Keep in step with kin-worker-server.service; `check` compares every entry.
SANDBOX=(
  -p ProtectHome=tmpfs
  -p "BindPaths=$WORKER_HOME"
  -p "BindReadOnlyPaths=$KIN_HOME/kin-current:$BUILD"
  -p PrivateTmp=yes
  -p ProtectProc=invisible
  -p NoNewPrivileges=yes
  -p ProtectSystem=full
  -p "SocketBindDeny=ipv4:tcp:$KIN_PORT"
  -p "SocketBindDeny=ipv6:tcp:$KIN_PORT"
  -p "IPAddressDeny=$DENIED_NETWORKS"
  -p MemoryMax=60%
  -p TasksMax=4096
)
DRY_RUN=0

say() { printf '%s\n' "$*"; }
die() { echo "kin-worker: $*" >&2; exit 1; }
run_cmd() {
  printf '+ %s\n' "$*"
  if [ "$DRY_RUN" -eq 0 ]; then "$@"; fi
}
need_root() { [ "$(id -u)" -eq 0 ] || die "run this as root: sudo $0 $*"; }
node_version_of() {
  sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' "$1/package.json" | head -n1
}

# Runs a root-owned binary (absolute path) as `user`, with no groups, no new privileges and the
# system PATH: it opens only what that user can, so root never follows a path the user controls.
as_user() {
  local user="$1"
  shift
  /usr/bin/setpriv --reuid="$(id -u "$user")" --regid="$(id -g "$user")" --clear-groups \
    --no-new-privs -- /usr/bin/env -i HOME="/home/$user" PATH="$SYSTEM_PATH" "$@"
}
worker_do() { as_user "$WORKER_USER" "$@"; }

# `node <args>`: Kin's build's server CLI. Runs as kin-worker inside the sandbox, where the build
# is at $BUILD; the worker unit starts the server with it.
cmd_node() {
  [ "$(id -un)" = "$WORKER_USER" ] || die "node runs as $WORKER_USER inside the sandbox; use: sudo kin-worker run t3 ..."
  local version
  version="$(node_version_of "$BUILD")"
  [ -n "$version" ] || die "no engines.node in $BUILD/package.json; is Kin's build bound?"
  # Kin is off here: nothing in this environment runs a lead or reads Kin's state.
  unset KIN_ENABLED KIN_REPO KIN_CHECKOUT KIN_NODE_VERSION KIN_MEMORY_REPOSITORIES
  mise install --quiet "node@$version" >/dev/null
  exec mise exec "node@$version" -- node "$BUILD/apps/server/dist/bin.mjs" "$@"
}

# The unit's own `IPAddressAllow=` (a drop-in), so `run` reaches what the server reaches.
allowed_networks() {
  local allow
  allow="$(systemctl show -P IPAddressAllow kin-worker-server.service 2>/dev/null || true)"
  if [ -n "$allow" ]; then printf '%s\n' -p "IPAddressAllow=$allow"; fi
}

# `run [--] <command...>`: a command as kin-worker with the worker unit's sandbox.
cmd_run() {
  need_root run
  if [ "${1:-}" = -- ]; then shift; fi
  [ $# -gt 0 ] || die "run needs a command"
  if [ "$1" = t3 ]; then
    shift
    set -- /usr/local/sbin/kin-worker node "$@"
  fi
  local io=--pipe allow=()
  if [ -t 0 ] && [ -t 1 ]; then io=--pty; fi
  mapfile -t allow < <(allowed_networks)
  systemd-run --quiet --wait --collect "$io" \
    --uid="$WORKER_USER" --gid="$WORKER_USER" \
    --working-directory="$WORKER_HOME" \
    --setenv=HOME="$WORKER_HOME" --setenv=PATH="$WORKER_PATH" \
    "${SANDBOX[@]}" "${allow[@]}" -- "$@"
}

refuse_unsafe_users() {
  local user
  for user in "$KIN_USER" "$WORKER_USER"; do
    if ! id -u "$user" >/dev/null 2>&1; then continue; fi
    [ "$(id -u "$user")" -ge 1000 ] || die "$user has uid $(id -u "$user"), a system account."
    for group in $(id -nG "$user"); do
      case "$group" in
        sudo | wheel | admin | root | docker | lxd | libvirt | disk) die "$user is in the $group group." ;;
      esac
    done
  done
  if id -u "$WORKER_USER" >/dev/null 2>&1; then
    for group in $(id -nG "$WORKER_USER"); do
      [ "$group" != "$KIN_USER" ] || die "$WORKER_USER is in the $KIN_USER group, so it could read kin's files."
    done
  fi
}

# Root runs what it installs from here, so nobody else may be able to change it.
refuse_unsafe_source() {
  local path="$SCRIPT_DIR" file
  while :; do
    [ "$(stat -c %u "$path")" = 0 ] || die "$path isn't owned by root. Run this from a root-owned clone (README, \"Workers\")."
    [ $((8#$(stat -c %a "$path") & 8#022)) -eq 0 ] || [ "$(stat -c %a "$path")" = 1777 ] ||
      die "$path is writable by others. Run this from a root-owned clone."
    [ "$path" = / ] && break
    path="$(dirname "$path")"
  done
  for file in kin-worker.sh "${UNITS[@]}"; do
    [ "$(stat -c %u "$SCRIPT_DIR/$file")" = 0 ] || die "$SCRIPT_DIR/$file isn't owned by root."
    [ $((8#$(stat -c %a "$SCRIPT_DIR/$file") & 8#022)) -eq 0 ] || die "$SCRIPT_DIR/$file is writable by others."
  done
}

ensure_mode_700() {
  if [ "$(stat -c %a "$1")" != 700 ]; then run_cmd chmod 0700 "$1"; fi
}

# The gateway URL for the worker's Claude settings: KIN_WORKER_GATEWAY_URL, else the
# ANTHROPIC_BASE_URL in kin's settings. Only that one value is read from kin's file.
gateway_url() {
  if [ -n "${KIN_WORKER_GATEWAY_URL:-}" ]; then
    printf '%s\n' "$KIN_WORKER_GATEWAY_URL"
    return
  fi
  [ -f "$KIN_HOME/.claude/settings.json" ] || return 0
  /usr/bin/python3 -I -c 'import json, sys
print(json.load(open(sys.argv[1])).get("env", {}).get("ANTHROPIC_BASE_URL", ""))' \
    "$KIN_HOME/.claude/settings.json" 2>/dev/null || true
}

# Writes stdin to a new file of the worker's, mode 600, as kin-worker; an existing one stays.
# Exits 3 when the file is already there.
worker_write_new() {
  worker_do /bin/sh -c 'umask 077
if [ -e "$1" ] || [ -L "$1" ]; then exit 3; fi
/usr/bin/install -d -m 0700 "$(dirname "$1")" && cat >"$1"' sh "$1"
}

write_claude_settings() {
  local settings="$WORKER_HOME/.claude/settings.json" url code=0
  url="$(gateway_url)"
  if ! [[ "$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]]; then
    say "No gateway URL for the worker's Claude settings: set KIN_WORKER_GATEWAY_URL=https://... and run this again."
    return 0
  fi
  # Only the gateway and a helper that reads the worker's own key; never kin's file or key.
  printf '{\n  "env": { "ANTHROPIC_BASE_URL": "%s" },\n  "apiKeyHelper": "cat %s"\n}\n' "$url" "$GATEWAY_KEY" |
    worker_write_new "$settings" || code=$?
  case "$code" in
    0) say "Wrote $settings with gateway $url. Put kin-worker's own gateway key in $GATEWAY_KEY (README, \"Workers\")." ;;
    3) say "$settings exists; check verifies it holds no token and names nothing of kin's." ;;
    *) die "couldn't write $settings as $WORKER_USER." ;;
  esac
  worker_do /usr/bin/install -d -m 0700 "$(dirname "$GATEWAY_KEY")"
}

# kin may stop, start or restart the worker server, with no argument of anyone else's: the
# stop switch and its resume (workerEnvironment.ts), and update.sh's move to a new build. And it
# may fetch a worker's repository through `upload-pack`, which checks its one path itself.
SUDOERS_LINE="$KIN_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop kin-worker-server.service, /usr/bin/systemctl start kin-worker-server.service, /usr/bin/systemctl try-restart kin-worker-server.service, /usr/local/sbin/kin-worker upload-pack *"
install_sudoers() {
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' \
    "# Installed by ops/kin/host/kin-worker.sh. kin may stop, start or restart the worker environment and read workers' repositories, nothing else." \
    "$SUDOERS_LINE" \
    >"$tmp"
  if cmp -s "$tmp" "$SUDOERS"; then
    rm -f "$tmp"
    return 0
  fi
  visudo -cqf "$tmp" || { rm -f "$tmp"; die "the sudoers entry didn't validate."; }
  run_cmd install -m 0440 -o root -g root "$tmp" "$SUDOERS"
  rm -f "$tmp"
}

# How many of Kin's orgs are paused, read by kin with the system sqlite3, read-only.
kin_paused_orgs() {
  as_user "$KIN_USER" /usr/bin/sqlite3 -readonly -batch -noheader -cmd ".timeout 2000" "$KIN_DB" \
    "SELECT count(*) FROM kin_org_state WHERE paused = 1;"
}

# `may-start`: the worker unit's ExecCondition. Exit 0 only when Kin's database shows no paused
# org; any error keeps the worker server stopped. Kin's pause stops the unit, and this keeps it
# stopped until the owner resumes, whoever starts it.
cmd_may_start() {
  need_root may-start
  local paused
  paused="$(kin_paused_orgs 2>/dev/null)" || {
    echo "kin-worker: can't read Kin's pause state from $KIN_DB, so the worker server stays stopped." >&2
    exit 1
  }
  [ "$paused" = 0 ] || {
    echo "kin-worker: Kin is paused, so the worker server stays stopped until the owner resumes." >&2
    exit 1
  }
}

# `upload-pack <path>`: Kin's server fetches a worker's branch through this (an `ext::` remote in
# workerPublish.ts) and pushes it itself, so workers need no GitHub write credential. git runs as
# kin-worker in the sandbox without the worker's global config, its output capped. Never while
# Kin is paused.
cmd_upload_pack() {
  need_root upload-pack
  [ $# -eq 1 ] || die "upload-pack takes one path"
  local path="$1" allow=()
  [[ "$path" =~ ^$WORKER_HOME/[A-Za-z0-9._/-]+$ ]] || die "upload-pack serves only a path under $WORKER_HOME"
  case "$path/" in */../* | */./*) die "upload-pack refuses a path with . or .. in it" ;; esac
  cmd_may_start
  mapfile -t allow < <(allowed_networks)
  systemd-run --quiet --wait --collect --pipe \
    --uid="$WORKER_USER" --gid="$WORKER_USER" --working-directory="$WORKER_HOME" \
    --setenv=HOME="$WORKER_HOME" --setenv=PATH="$SYSTEM_PATH" \
    --setenv=GIT_CONFIG_GLOBAL=/dev/null --setenv=GIT_CONFIG_NOSYSTEM=1 \
    "${SANDBOX[@]}" "${allow[@]}" -p RuntimeMaxSec=300 \
    -- /usr/bin/git upload-pack --timeout=60 "$path" | head -c "$UPLOAD_PACK_MAX_BYTES"
}

install_steps() {
  if [ "$DRY_RUN" -eq 0 ]; then
    [ "$(uname -s)" = Linux ] || die "needs Linux with systemd."
    need_root install
    refuse_unsafe_source
  fi
  id -u "$KIN_USER" >/dev/null 2>&1 || die "no $KIN_USER user yet: run /root/kin-ops/ops/kin/host/setup.sh first."
  refuse_unsafe_users

  # 1. The worker user, with a home only it can read. Kin's home gets the same.
  if id -u "$WORKER_USER" >/dev/null 2>&1; then
    say "User $WORKER_USER exists."
  else
    run_cmd useradd --create-home --home-dir "$WORKER_HOME" --shell /bin/bash "$WORKER_USER"
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    ensure_mode_700 "$KIN_HOME"
    # The worker owns its home: kin-worker sets the mode, so root changes nothing it controls.
    if [ "$(stat -c %a "$WORKER_HOME")" != 700 ]; then worker_do /bin/chmod 0700 "$WORKER_HOME"; fi
  fi

  # 2. This script, the units, the sudoers entry and the build's mount point.
  if ! cmp -s "$SCRIPT_DIR/kin-worker.sh" /usr/local/sbin/kin-worker 2>/dev/null; then
    run_cmd install -m 0755 -o root -g root "$SCRIPT_DIR/kin-worker.sh" /usr/local/sbin/kin-worker
  fi
  local changed=0 unit
  for unit in "${OLD_UNITS[@]}"; do
    if [ -e "/etc/systemd/system/$unit" ]; then
      run_cmd systemctl disable --now "$unit" || true
      run_cmd rm -f "/etc/systemd/system/$unit"
      changed=1
    fi
  done
  for unit in "${UNITS[@]}"; do
    if ! cmp -s "$SCRIPT_DIR/$unit" "/etc/systemd/system/$unit" 2>/dev/null; then
      run_cmd install -m 0644 -o root -g root "$SCRIPT_DIR/$unit" "/etc/systemd/system/$unit"
      changed=1
    fi
  done
  if [ "$DRY_RUN" -eq 0 ]; then install_sudoers; else say "+ install $SUDOERS"; fi
  if [ ! -d "$BUILD" ]; then run_cmd install -d -m 0755 -o root -g root "$BUILD"; fi
  if [ "$changed" -eq 1 ]; then
    run_cmd systemctl daemon-reload
    # A running server keeps its old sandbox until it restarts.
    run_cmd systemctl try-restart kin-worker-server.service
  fi

  # 3. Linked environments on in the worker environment, so kin-server's link is accepted.
  if [ "$DRY_RUN" -eq 0 ]; then
    local code=0
    printf '{\n  "linkedEnvironmentsEnabled": true\n}\n' |
      worker_write_new "$WORKER_HOME/.t3/userdata/settings.json" || code=$?
    case "$code" in
      0) say "Wrote $WORKER_HOME/.t3/userdata/settings.json." ;;
      3) ;;
      *) die "couldn't write the worker environment's settings as $WORKER_USER." ;;
    esac
  fi

  # 4. Claude's gateway settings, the worker's own.
  if [ "$DRY_RUN" -eq 0 ]; then write_claude_settings; fi

  # 5. Start what can start.
  run_cmd systemctl enable kin-worker-server.service kin-worker-link.timer
  run_cmd systemctl start kin-worker-link.timer
  if [ -f "$KIN_HOME/kin-current/apps/server/dist/bin.mjs" ]; then
    run_cmd systemctl start kin-worker-server.service
  else
    say "No Kin build at $KIN_HOME/kin-current yet: run update.sh as $KIN_USER, then this again."
  fi
}

cmd_install() {
  if [ "${1:-}" = --dry-run ]; then DRY_RUN=1; fi
  install_steps
  if [ "$DRY_RUN" -eq 1 ]; then
    say ""
    say "Dry run: nothing was changed."
    return 0
  fi
  checklist
}

as_kin() {
  sudo -u "$KIN_USER" -H env \
    PATH="$KIN_HOME/.local/bin:$KIN_HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin" "$@"
}
kin_cli() {
  local version
  version="$(node_version_of "$KIN_HOME/kin-current")"
  as_kin mise exec "node@$version" -- node "$KIN_HOME/kin-current/apps/server/dist/bin.mjs" "$@"
}
in_sandbox() { /usr/local/sbin/kin-worker run -- "$@" </dev/null; }
trusted_bins() {
  local bin
  for bin in "${TRUSTED_BINS[@]}" /usr/bin/systemd-run /usr/bin/sudo; do
    [ -x "$bin" ] && [ "$(stat -L -c %u "$bin")" = 0 ] &&
      [ $((8#$(stat -L -c %a "$bin") & 8#022)) -eq 0 ] || return 1
  done
}
service_env_value() {
  sed -n "s/^$1=//p" "$KIN_HOME/.t3/service.env" 2>/dev/null | tail -n1
}

FAILED=0
check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$label"; else
    printf '  ✗ %s\n' "$label"
    FAILED=1
  fi
}
checklist() {
  say ""
  say "Kin worker environment checklist ($WORKER_USER, $WORKER_HOME)"
  FAILED=0
  check "git" in_sandbox git --version
  check "mise" in_sandbox mise --version
  check "Claude Code CLI" in_sandbox claude --version
  check "Codex CLI" in_sandbox codex --version
  check "the system binaries check runs are root-owned" trusted_bins
  check "kin-worker's own gateway key at $GATEWAY_KEY" worker_do /usr/bin/test -s "$GATEWAY_KEY"
  check "kin-worker-server running" systemctl is-active kin-worker-server.service
  check "weekly relink timer" systemctl is-active kin-worker-link.timer
  check "Kin's GitHub App configured, so Kin can publish workers' branches (KIN_GITHUB_APP_ID)" \
    test -n "$(service_env_value KIN_GITHUB_APP_ID)$(sed -n 's/^KIN_GITHUB_APP_ID=//p' "$KIN_HOME/.config/kin/kin-server.env" 2>/dev/null)"
  check "Linked environments on in kin's settings (Settings → Labs)" \
    sh -c "grep -q '\"linkedEnvironmentsEnabled\": *true' '$KIN_HOME/.t3/userdata/settings.json'"
  check "KIN_WORKER_ENVIRONMENT_ID in $KIN_HOME/.t3/service.env" test -n "$(service_env_value KIN_WORKER_ENVIRONMENT_ID)"
  if [ "$FAILED" -eq 1 ]; then
    say ""
    say "Fix the ✗ items (README.md, \"Workers\"), then: sudo kin-worker link && sudo kin-worker check"
    exit 1
  fi
  cmd_check
}

cmd_link() {
  need_root link
  systemctl is-active --quiet kin-worker-server.service || die "kin-worker-server is not running."
  local code linked id
  # The pairing code stays in this shell: it is never printed or logged.
  code="$(cmd_run t3 pair --base-dir "$WORKER_HOME/.t3" --label kin-server </dev/null | sed -n 's/^Token: //p' | tail -n1)"
  [ -n "$code" ] || die "the worker environment gave no pairing code."
  linked="$(kin_cli environment link "$WORKER_URL" --pairing-code "$code" --access full-access --base-dir "$KIN_HOME/.t3")"
  id="$(printf '%s\n' "$linked" | sed -n 's/^Linked .* (\([^)]*\)) with .*/\1/p' | head -n1)"
  # The id lands in kin's service.env, which systemd reads: nothing but an id may go there.
  [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || die "linking printed no usable environment id: $linked"
  say "$linked"
  local env_file="$KIN_HOME/.t3/service.env"
  if [ "$(service_env_value KIN_WORKER_ENVIRONMENT_ID)" = "$id" ]; then
    say "$env_file already names $id."
    return 0
  fi
  if [ -f "$env_file" ]; then
    sed -i '/^KIN_WORKER_ENVIRONMENT_ID=/d' "$env_file"
  else
    install -m 0600 -o "$KIN_USER" -g "$KIN_USER" /dev/null "$env_file"
  fi
  printf 'KIN_WORKER_ENVIRONMENT_ID=%s\n' "$id" >>"$env_file"
  say "Set KIN_WORKER_ENVIRONMENT_ID=$id in $env_file. Apply it at a quiet moment:"
  say "  sudo -u $KIN_USER XDG_RUNTIME_DIR=/run/user/$(id -u "$KIN_USER") systemctl --user restart kin-server"
}

# --- setup -----------------------------------------------------------------------------------

# One secret from the terminal into SECRET. Echo goes off before the prompt shows, so a paste
# that lands early isn't shown either. It stays in this shell: never printed, logged or put on a
# command line. No terminal reads as skipped.
SECRET=""
TTY_SAVED=""
ask_secret() {
  SECRET=""
  if ! { : >/dev/tty; } 2>/dev/null; then
    say "No terminal to ask on (use ssh -t), so this was skipped."
    return 0
  fi
  TTY_SAVED="$(stty -g </dev/tty)"
  trap 'stty "$TTY_SAVED" </dev/tty' EXIT
  stty -echo </dev/tty
  printf '%s' "$1" >/dev/tty
  IFS= read -r SECRET </dev/tty || true
  stty "$TTY_SAVED" </dev/tty
  trap - EXIT
  printf '\n' >/dev/tty
}

# mise, the build's Node, Claude Code and Codex in kin-worker's own home, installed by kin-worker
# inside the sandbox, so nothing of root's, kin's or the owner's is within the installers' reach.
setup_tools() {
  local version tool
  version="$(node_version_of "$KIN_HOME/kin-current")"
  [ -n "$version" ] || die "no engines.node in $KIN_HOME/kin-current/package.json."
  if ! in_sandbox mise --version >/dev/null 2>&1; then
    say "Installing mise for $WORKER_USER."
    in_sandbox /bin/sh -c '/usr/bin/curl -fsSL https://mise.run | /bin/sh' >/dev/null ||
      die "couldn't install mise as $WORKER_USER. Is https://mise.run reachable from the sandbox?"
  fi
  in_sandbox mise use --global "node@$version" >/dev/null ||
    die "couldn't install Node $version as $WORKER_USER."
  for tool in claude:@anthropic-ai/claude-code codex:@openai/codex; do
    if in_sandbox "${tool%%:*}" --version >/dev/null 2>&1; then continue; fi
    say "Installing ${tool#*:} for $WORKER_USER."
    in_sandbox mise exec "node@$version" -- npm install --global --silent "${tool#*:}" ||
      die "couldn't install ${tool#*:} as $WORKER_USER."
  done
  in_sandbox mise reshim
  say "Tools are in $WORKER_HOME: mise, Node $version, Claude Code, Codex."
}

# The first credential: kin-worker's own Claude gateway key, written by kin-worker to a file only
# it can read. A key already there stays. One that is kin's own is taken back out.
setup_gateway_key() {
  local wrote=0
  if worker_do /usr/bin/test -s "$GATEWAY_KEY"; then
    say "$WORKER_USER already has a gateway key; keeping it. To replace it: sudo kin-worker run -- rm $GATEWAY_KEY, then setup again."
  else
    ask_secret "Claude gateway key for $WORKER_USER alone, never kin's or yours (Enter to skip): "
    if [ -z "$SECRET" ]; then
      say "No gateway key yet: workers can't use Claude until setup is run again with one."
      return 0
    fi
    if ! [[ "$SECRET" =~ ^[[:graph:]]+$ ]]; then
      SECRET=""
      die "that key has spaces or unprintable characters; nothing was written."
    fi
    # An empty file from an attempt that failed would block the new one.
    worker_do /bin/rm -f "$GATEWAY_KEY"
    printf '%s\n' "$SECRET" | worker_write_new "$GATEWAY_KEY" || {
      SECRET=""
      die "couldn't write the key as $WORKER_USER."
    }
    SECRET=""
    wrote=1
  fi
  if ! own_gateway_key; then
    if [ "$wrote" -eq 1 ]; then worker_do /bin/rm -f "$GATEWAY_KEY"; fi
    die "$WORKER_USER's gateway key is kin's own, which a worker must never hold. Create one for $WORKER_USER alone (and remove an old one: sudo kin-worker run -- rm $GATEWAY_KEY), then setup again."
  fi
  if [ "$wrote" -eq 1 ]; then say "Wrote the key to $GATEWAY_KEY (mode 600, $WORKER_USER's)."; fi
  if in_sandbox /usr/bin/timeout 90 claude -p ok >/dev/null 2>&1; then
    say "Claude answers as $WORKER_USER."
  else
    say "Claude didn't answer as $WORKER_USER yet. Try: sudo kin-worker run -- claude -p ok"
  fi
}

# The second credential, optional: Codex, on an account that is not the owner's.
setup_codex() {
  if in_sandbox codex login status >/dev/null 2>&1; then
    say "Codex is signed in for $WORKER_USER."
    return 0
  fi
  ask_secret "Codex API key for a separate account with a spending cap, never the owner's (Enter to skip Codex): "
  if [ -z "$SECRET" ]; then
    say "Codex skipped: workers use Claude only. To sign in later: sudo kin-worker run -- codex login"
    return 0
  fi
  if printf '%s\n' "$SECRET" | /usr/local/sbin/kin-worker run -- codex login --with-api-key >/dev/null 2>&1; then
    say "Codex is signed in for $WORKER_USER."
  else
    say "Codex didn't accept that key. To try again: sudo kin-worker run -- codex login --with-api-key < <key file>"
  fi
  SECRET=""
}

# Linked environments on kin-server, which watches its settings file: kin sets the one key in
# its own file and every other setting stays as it was. A file it can't parse is left alone.
enable_kin_links() {
  as_user "$KIN_USER" /usr/bin/python3 -I -c 'import json, os, sys
path = os.path.realpath(sys.argv[1])
try:
    with open(path) as handle:
        data = json.load(handle)
except FileNotFoundError:
    data = {}
if not isinstance(data, dict):
    sys.exit(1)
if data.get("linkedEnvironmentsEnabled") is True:
    sys.exit(0)
data["linkedEnvironmentsEnabled"] = True
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
scratch = path + ".kin-worker-setup"
with os.fdopen(os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
os.replace(scratch, path)' "$KIN_HOME/.t3/userdata/settings.json"
}

# Kin's memory repositories, as owner/repo. Workers get no checkout of those.
memory_repos() {
  cat "$KIN_HOME/.t3/service.env" "$KIN_HOME/.config/kin/kin-server.env" 2>/dev/null |
    sed -n 's/^KIN_MEMORY_REPOSITORIES=//p' |
    grep -oE 'github\.com[:/][A-Za-z0-9-]+/[A-Za-z0-9._-]+' |
    sed -e 's#^github\.com[:/]##' -e 's/\.git$//' | sort -u
}
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
checkout_origin() {
  in_sandbox /usr/bin/git -C "$1" remote get-url origin 2>/dev/null |
    sed -n 's#^.*github\.com[:/]\([^/]*/[^/]*\)$#\1#p' | sed 's/\.git$//'
}
# One repository: a checkout of kin-worker's, cloned by kin-worker in the sandbox with whatever
# read access it has, and registered in the worker environment. Run again, it changes nothing.
setup_project() {
  local slug="$1" dir="$WORKER_HOME/projects/${1#*/}" origin added
  origin="$(checkout_origin "$dir" || true)"
  if [ -n "$origin" ] && [ "$(lower "$origin")" != "$(lower "$slug")" ]; then
    # Another owner's repository of the same name already has that directory.
    dir="$WORKER_HOME/projects/${slug%%/*}-${slug#*/}"
    origin="$(checkout_origin "$dir" || true)"
  fi
  if [ -z "$origin" ]; then
    if in_sandbox /usr/bin/test -e "$dir"; then
      say "  ✗ $slug: $dir is there and isn't a checkout of it."
      return 1
    fi
    if ! in_sandbox /usr/bin/env GIT_TERMINAL_PROMPT=0 /usr/bin/git clone --quiet "https://github.com/$slug" "$dir"; then
      say "  ✗ $slug: couldn't clone it. A private repository needs kin-worker's read-only token first (README, \"Set up workers\")."
      return 1
    fi
  elif [ "$(lower "$origin")" != "$(lower "$slug")" ]; then
    say "  ✗ $slug: $dir is a checkout of $origin."
    return 1
  fi
  added="$(in_sandbox t3 project add "$dir" --base-dir "$WORKER_HOME/.t3" 2>&1 || true)"
  case "$added" in
    *"Added project"*) say "  ✓ $slug at $dir" ;;
    *"already exists"*) say "  ✓ $slug at $dir, already registered" ;;
    *)
      say "  ✗ $slug: it is at $dir, but registering it failed: $(printf '%s\n' "$added" | tail -n1)"
      return 1
      ;;
  esac
}
# Every repository Kin publishes to (KIN_GITHUB_REPOS and Kin's own), plus any named on the
# command line: the ones a lead's work can end in a pull request on.
setup_projects() {
  local slug skip repos missing=0
  skip="$(memory_repos || true)"
  repos="$({
    kin_repos || true
    printf '%s\n' "$@"
  } | sed 's/[[:space:]]//g' | grep -E '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' | sort -u || true)"
  if [ -z "$repos" ]; then
    say "No repositories to clone: KIN_GITHUB_REPOS is empty. Name them: setup <owner>/<repo> ..."
    return 0
  fi
  say "Projects in the worker environment:"
  for slug in $repos; do
    if grep -qixF "$slug" <<<"$skip"; then continue; fi
    setup_project "$slug" || missing=1
  done
  if [ "$missing" -eq 1 ]; then say "Leads can't start work in the ✗ ones until they are fixed; run setup again then."; fi
}

# `setup [owner/repo ...]`: every step from a fresh host to a passing `check` that needs no
# credential, and a prompt for the two that do. Safe to run again: each step keeps what is there.
cmd_setup() {
  local repos=() arg before
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -*) die "setup takes repositories as owner/repo, and --dry-run." ;;
      *) repos+=("$arg") ;;
    esac
  done
  if [ "$DRY_RUN" -eq 1 ]; then
    install_steps
    say "+ as $WORKER_USER, in the sandbox: install mise, the build's Node, Claude Code and Codex"
    say "+ ask for $WORKER_USER's Claude gateway key, and optionally a Codex API key"
    say "+ turn on Linked environments in kin's settings"
    say "+ clone and register every repository in KIN_GITHUB_REPOS and Kin's own ${repos[*]:-}"
    say "+ kin-worker link, then kin-worker check"
    say ""
    say "Dry run: nothing was changed."
    return 0
  fi
  need_root setup
  [ -f "$KIN_HOME/kin-current/apps/server/dist/bin.mjs" ] ||
    die "no Kin build at $KIN_HOME/kin-current yet: run update.sh as $KIN_USER first (README, \"Install\")."
  install_steps
  setup_tools
  setup_gateway_key
  setup_codex
  if enable_kin_links; then say "Linked environments are on for kin-server."; else
    say "Couldn't turn on Linked environments in kin's settings. From any client: Settings → Labs → Linked environments."
  fi
  setup_projects ${repos[@]+"${repos[@]}"}
  if [ "$(stat -c %d "$WORKER_HOME")" = "$(stat -c %d "$KIN_HOME")" ]; then
    say "Note: $WORKER_HOME shares a filesystem with $KIN_HOME. Give $WORKER_USER a disk quota or its own filesystem, so a worker can't fill Kin's disk."
  fi
  systemctl is-active --quiet kin-worker-server.service || systemctl start kin-worker-server.service || true
  before="$(service_env_value KIN_WORKER_ENVIRONMENT_ID)"
  cmd_link
  if [ "$(service_env_value KIN_WORKER_ENVIRONMENT_ID)" != "$before" ]; then
    say "Leads can start workers once kin-server restarts with that id. Nothing here restarts it."
  fi
  checklist
}

# --- check -----------------------------------------------------------------------------------

live_pid() { [ -n "$1" ] && [ "$1" != 0 ] && kill -0 "$1"; }

# Runs a probe as kin-worker inside the running server's own mount namespace, which is where
# workers' shells run. cgroup rules (SocketBindDeny, IPAddressDeny, limits) don't follow nsenter;
# those are probed in a fresh `run` sandbox, which `sandbox_matches` shows is the same.
in_service() {
  /usr/bin/nsenter --target "$SERVICE_PID" --mount -- \
    /usr/bin/setpriv --reuid="$(id -u "$WORKER_USER")" --regid="$(id -g "$WORKER_USER")" --clear-groups --no-new-privs -- \
    /usr/bin/env -i HOME="$WORKER_HOME" PATH="$SYSTEM_PATH" /bin/sh -c "cd / && $1" </dev/null
}
as_login() { sudo -u "$WORKER_USER" -H /usr/bin/env PATH="$SYSTEM_PATH" /bin/sh -c "$1" </dev/null; }
# A probe as kin-worker in a fresh sandbox like the server's, with only the system's binaries.
in_probe_sandbox() {
  local allow=()
  mapfile -t allow < <(allowed_networks)
  systemd-run --quiet --wait --collect --pipe \
    --uid="$WORKER_USER" --gid="$WORKER_USER" --working-directory="$WORKER_HOME" \
    --setenv=HOME="$WORKER_HOME" --setenv=PATH="$SYSTEM_PATH" \
    "${SANDBOX[@]}" "${allow[@]}" -- "$@" </dev/null
}

# Starts a throwaway unit with SANDBOX and compares each of its properties with the server's,
# in systemd's own normalized form.
sandbox_matches() {
  local probe=kin-worker-sandbox-probe names name allow=() differs=()
  mapfile -t allow < <(allowed_networks)
  systemctl stop "$probe.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$probe.service" >/dev/null 2>&1 || true
  if ! systemd-run --quiet --collect --unit="$probe" --uid="$WORKER_USER" --gid="$WORKER_USER" \
    "${SANDBOX[@]}" "${allow[@]}" -- sleep 120 >/dev/null 2>&1; then
    printf '  ✗ the sandbox probe unit could not start\n'
    FAILED=1
    return
  fi
  names="$(printf '%s\n' "${SANDBOX[@]}" | sed -n 's/^\([A-Za-z]*\)=.*/\1/p' | sort -u)"
  for name in $names; do
    if [ "$(systemctl show -P "$name" "$probe.service")" != "$(systemctl show -P "$name" kin-worker-server.service)" ]; then
      differs+=("$name")
    fi
  done
  systemctl stop "$probe.service" >/dev/null 2>&1 || true
  if [ ${#differs[@]} -eq 0 ]; then
    printf '  ✓ kin-worker-server runs with every sandbox setting of kin-worker run\n'
  else
    printf '  ✗ kin-worker-server differs from the sandbox in: %s\n' "${differs[*]}"
    FAILED=1
  fi
}

# Exits 0 only when binding the address is refused by policy, not because the port is taken.
BIND_PROBE='import errno, socket, sys
family = socket.AF_INET6 if ":" in sys.argv[1] else socket.AF_INET
s = socket.socket(family, socket.SOCK_STREAM)
try:
    s.bind((sys.argv[1], int(sys.argv[2])))
except OSError as error:
    sys.exit(0 if error.errno in (errno.EPERM, errno.EACCES) else 1)
sys.exit(1)'

# Listeners of kin's processes other than kin-server's port, and abstract sockets of kin's: a
# worker shares the host's network namespace, so it can reach any of them.
kin_listeners() {
  local kin_uid line pid
  kin_uid="$(id -u "$KIN_USER")"
  ss -H -ltunep 2>/dev/null | awk -v uid="uid:$kin_uid" -v port="$KIN_PORT" '
    { for (i = 1; i <= NF; i++) if ($i == uid) { split($5, a, ":"); if (a[length(a)] != port) print; next } }'
  ss -H -lxp 2>/dev/null | awk '$5 ~ /^@/' | while IFS= read -r line; do
    for pid in $(printf '%s\n' "$line" | grep -o 'pid=[0-9]*' | cut -d= -f2); do
      if [ "$(stat -c %u "/proc/$pid" 2>/dev/null)" = "$kin_uid" ]; then
        printf '%s\n' "$line"
        break
      fi
    done
  done
}
no_kin_listeners() { [ -z "$(kin_listeners)" ]; }

# Files of kin's that any user can read, on every local filesystem but /home (mode 700 walls).
kin_world_readable() {
  local mounts
  mounts="$(findmnt -rn -o TARGET -t ext2,ext3,ext4,xfs,btrfs,zfs,f2fs,tmpfs,vfat,exfat 2>/dev/null)"
  # shellcheck disable=SC2086
  find $mounts -xdev \( -path /home -o -path /proc -o -path /sys -o -path /dev/pts \
    -o -path "/run/user/$(id -u "$KIN_USER")" \) -prune \
    -o -user "$KIN_USER" -type f -perm -o+r -print 2>/dev/null | head -n 20
}
no_kin_world_readable() { [ -z "$(kin_world_readable)" ]; }
no_acl() { [ "$(ls -ld "$1" | cut -c11)" != + ]; }
home_closed() { [ "$(stat -c %a "$1")" = 700 ] && no_acl "$1"; }

# The worker's Claude settings as text, read by kin-worker, never by root through its path.
worker_settings() { worker_do /bin/cat "$WORKER_HOME/.claude/settings.json"; }
sha() { /usr/bin/sha256sum | cut -d' ' -f1; }
# kin's gateway key: its apiKeyHelper's output, else an inline key.
kin_key_hash() {
  local settings="$KIN_HOME/.claude/settings.json" helper key
  [ -f "$settings" ] || return 0
  helper="$(/usr/bin/python3 -I -c 'import json, sys
print(json.load(open(sys.argv[1])).get("apiKeyHelper", ""))' "$settings" 2>/dev/null || true)"
  if [ -n "$helper" ]; then key="$(as_kin sh -c "$helper" 2>/dev/null || true)"; else
    key="$(/usr/bin/python3 -I -c 'import json, sys
env = json.load(open(sys.argv[1])).get("env", {})
print(env.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_AUTH_TOKEN") or "")' "$settings" 2>/dev/null || true)"
  fi
  if [ -n "$key" ]; then printf '%s' "$key" | tr -d '\r\n' | sha; fi
}
# The worker's key is the file its settings' helper reads (settings_hold_no_token checks that).
# Line ends are dropped on both sides: kin's key with a newline after it is still kin's key.
own_gateway_key() {
  local mine theirs
  mine="$(worker_do /bin/cat "$GATEWAY_KEY" 2>/dev/null | tr -d '\r\n' | sha)"
  theirs="$(kin_key_hash)"
  [ "$mine" != "$(printf '' | sha)" ] && [ "$mine" != "$theirs" ]
}
# The worker's settings carry no token inline, name nothing of kin's, and read the key file.
settings_hold_no_token() {
  local text
  text="$(worker_settings)" || return 1
  ! grep -q "$KIN_HOME" <<<"$text" || return 1
  ! grep -Eq 'sk-ant|gh[opsu]_[A-Za-z0-9]|github_pat_' <<<"$text" || return 1
  /usr/bin/python3 -I -c 'import json, re, sys
data = json.loads(sys.stdin.read())
env = data.get("env", {})
ok = data.get("apiKeyHelper") == "cat " + sys.argv[1] and not any(
    re.search("KEY|TOKEN|SECRET|PASSWORD", k, re.I) for k in env)
sys.exit(0 if ok else 1)' "$GATEWAY_KEY" <<<"$text"
}
# Kin's repository as owner/repo, from kin's clone that update.sh builds.
kin_repo_slug() {
  local repo url
  repo="$(sed -n 's/^KIN_REPO=//p' "$KIN_HOME/.config/kin/kin-server.env" 2>/dev/null | tail -n1)"
  url="$(as_kin git -C "${repo:-$KIN_HOME/t3code}" remote get-url origin 2>/dev/null || true)"
  printf '%s\n' "$url" | sed -n 's#^.*github\.com[:/]\([^/]*/[^/]*\)$#\1#p' | sed 's/\.git$//'
}
# Every GitHub token kin-worker keeps where gh and git look (gh's hosts.yml, git's credential
# store), read by kin-worker. A token elsewhere goes unseen: this checks setup, not a hostile worker.
worker_github_tokens() {
  {
    worker_do /bin/cat "$WORKER_HOME/.config/gh/hosts.yml" 2>/dev/null |
      sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*\([^[:space:]]*\).*/\1/p'
    worker_do /bin/cat "$WORKER_HOME/.git-credentials" 2>/dev/null |
      sed -n 's#^https://[^:@/]*:\([^@]*\)@github\.com.*#\1#p'
  } | sort -u
}
# The repositories Kin publishes to: KIN_GITHUB_REPOS and Kin's own.
kin_repos() {
  {
    service_env_value KIN_GITHUB_REPOS | tr ',' '\n'
    kin_repo_slug
  } | sed 's/[[:space:]]//g' | grep -E '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' | sort -u
}
# GitHub's answer for a token on one repository, from the system curl; the token goes on stdin,
# never on a command line. Prints the body, then the HTTP status on its own line.
github_repo_as() {
  printf 'header = "Authorization: Bearer %s"\n' "$1" |
    /usr/bin/curl -sS -m 15 --config - -H 'Accept: application/vnd.github+json' \
      -w '\n%{http_code}' "https://api.github.com/repos/$2"
}
# No token of the worker's is kin's, and none can push to a repository Kin publishes to. A 401
# (bad token) or 404 (can't see it) can't push; any other answer, rate limits included, fails.
worker_tokens_read_only() {
  local token repo answer status theirs repos
  theirs="$(as_kin gh auth token 2>/dev/null | sha)"
  repos="$(kin_repos)"
  [ -n "$repos" ] || return 1
  while IFS= read -r token; do
    [ -n "$token" ] || continue
    [ "$(printf '%s\n' "$token" | sha)" != "$theirs" ] || return 1
    for repo in $repos; do
      answer="$(github_repo_as "$token" "$repo")" || return 1
      status="${answer##*$'\n'}"
      case "$status" in
        401 | 404) ;;
        200)
          /usr/bin/python3 -I -c 'import json, sys
sys.exit(0 if json.loads(sys.stdin.read()).get("permissions", {}).get("push") is False else 1)' \
            <<<"${answer%$'\n'*}" || return 1
          ;;
        *) return 1 ;;
      esac
    done
  done < <(worker_github_tokens)
}
links_json() {
  /usr/bin/python3 -I -c 'import json, sys
links = json.load(sys.stdin)
match = [l for l in links if l.get("environmentId") == sys.argv[1]]
sys.exit(0 if len(match) == 1 and sys.argv[2] in match[0].get("urls", []) else 1)' "$@"
}
# The worker's own database, read by kin-worker with the system sqlite3, read-only. Any error fails.
worker_has_no_links() {
  [ "$(worker_do /usr/bin/sqlite3 -readonly -batch -noheader -cmd ".timeout 2000" "$WORKER_DB" \
    "SELECT count(*) FROM peer_environment_links;")" = 0 ]
}
# From root, not from the server: the worker server's own process listens on its port only.
worker_server_listens_on_loopback_only() {
  local lines
  lines="$(/usr/bin/ss -H -ltnp 2>/dev/null | grep -F "pid=$SERVICE_PID," || true)"
  [ -n "$lines" ] && ! awk -v want="127.0.0.1:$WORKER_PORT" '$4 != want { bad = 1 } END { exit !bad }' <<<"$lines"
}
kin_link_is_loopback() {
  local id
  id="$(service_env_value KIN_WORKER_ENVIRONMENT_ID)"
  [ -n "$id" ] || return 1
  kin_cli environment list --base-dir "$KIN_HOME/.t3" --json | links_json "$id" "$WORKER_URL"
}
refuses() {
  in_probe_sandbox /usr/bin/curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$1" "${@:3}" "$2" |
    grep -Eqx '401|403'
}

# Each probe must fail. They run as kin-worker three ways: inside the running server's mount
# namespace, in a fresh sandbox like the server's, and as a plain login, where kin's mode-700
# home is the second wall. Probes run only root-owned system binaries. This verifies the
# sandbox's configuration; a hostile worker controls its own server, so it is not attestation.
cmd_check() {
  need_root check
  local owner="${SUDO_USER:-}" probes kin_pid kin_url kin_uid unit
  kin_url="${KIN_URL:-http://127.0.0.1:$KIN_PORT}"
  kin_uid="$(id -u "$KIN_USER")"
  kin_pid="$(systemctl --user -M "$KIN_USER@" show -P MainPID kin-server 2>/dev/null || true)"
  SERVICE_PID="$(systemctl show -P MainPID kin-worker-server.service 2>/dev/null || true)"
  FAILED=0
  say ""
  say "Isolation: each line is something a worker's shell must not be able to do, or a wall it stands on."
  check "kin-server is running (MainPID ${kin_pid:-none})" live_pid "$kin_pid"
  check "kin-worker-server is running (MainPID ${SERVICE_PID:-none})" live_pid "$SERVICE_PID"
  for unit in "${UNITS[@]}"; do
    check "$unit runs as installed (no daemon-reload pending)" \
      sh -c "[ \"\$(systemctl show -P NeedDaemonReload $unit)\" = no ]"
  done
  sandbox_matches
  if [ "$FAILED" -eq 1 ]; then
    say ""
    say "The probes below would test the wrong thing. Fix the ✗ items first."
    exit 1
  fi

  probes=(
    "read Kin's database|cat $KIN_HOME/.t3/userdata/statev2.sqlite"
    "list Kin's secrets|ls $KIN_HOME/.t3/userdata/secrets"
    "list ~kin/.config/kin (memory key, APNs key, GitHub App key)|ls $KIN_HOME/.config/kin"
    "read service.env|cat $KIN_HOME/.t3/service.env"
    "read kin's Claude login|ls $KIN_HOME/.claude"
    "read kin's Codex login|ls $KIN_HOME/.codex"
    "read kin-server's environment|cat /proc/$kin_pid/environ"
    "list kin's runtime directory|ls /run/user/$kin_uid"
    "reach kin's session bus|test -e /run/user/$kin_uid/bus"
    "read kin's keyring|test -n \"\$(DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$kin_uid/bus secret-tool lookup service kin-github-app 2>/dev/null)\""
  )
  if [ -n "$owner" ] && [ "$owner" != root ]; then
    probes+=("list the owner's home ($owner)|ls /home/$owner")
  fi
  local probe label command
  for probe in "${probes[@]}"; do
    label="${probe%%|*}"
    command="${probe#*|}"
    if in_service "$command" >/dev/null 2>&1; then
      printf '  ✗ service: can %s\n' "$label"
      FAILED=1
    else printf '  ✓ service: can'\''t %s\n' "$label"; fi
    if in_probe_sandbox /bin/sh -c "$command" >/dev/null 2>&1; then
      printf '  ✗ sandbox: can %s\n' "$label"
      FAILED=1
    else printf '  ✓ sandbox: can'\''t %s\n' "$label"; fi
    if as_login "$command" >/dev/null 2>&1; then
      printf '  ✗ login:   can %s\n' "$label"
      FAILED=1
    else printf '  ✓ login:   can'\''t %s\n' "$label"; fi
  done
  check "sandbox: can't sudo" in_probe_sandbox /bin/sh -c "! /usr/bin/sudo -n true"
  check "sandbox: binding 127.0.0.1:$KIN_PORT is refused" in_probe_sandbox /usr/bin/python3 -I -c "$BIND_PROBE" 127.0.0.1 "$KIN_PORT"
  check "sandbox: binding [::1]:$KIN_PORT is refused" in_probe_sandbox /usr/bin/python3 -I -c "$BIND_PROBE" ::1 "$KIN_PORT"
  check "sandbox: can't reach cloud metadata (169.254.169.254)" \
    in_probe_sandbox /bin/sh -c "! /usr/bin/curl -s -m 5 -o /dev/null http://169.254.169.254/"
  check "sandbox: DNS still resolves (github.com)" in_probe_sandbox /usr/bin/getent hosts github.com
  check "Kin's /mcp refuses a call with no credential ($kin_url)" refuses POST "$kin_url/mcp"
  check "Kin's /kin/mcp refuses a call with no credential" refuses POST "$kin_url/kin/mcp"
  check "Kin's /ws refuses an upgrade with no credential" refuses GET "$kin_url/ws?orchestrationProtocol=2" \
    -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: a2luLXdvcmtlci1jaGVjaw=="
  check "Kin's websocket ticket endpoint refuses with no credential" refuses POST "$kin_url/api/auth/websocket-ticket"
  check "Kin's pairing endpoint refuses with no credential" refuses POST "$kin_url/api/auth/pairing-token" \
    -H "Content-Type: application/json" --data '{}'
  check "no kin process listens anywhere else, and kin has no abstract sockets" no_kin_listeners
  check "no file of kin's outside /home is readable by everyone" no_kin_world_readable
  check "$KIN_HOME is mode 700 with no ACL" home_closed "$KIN_HOME"
  check "$WORKER_HOME is mode 700 with no ACL" home_closed "$WORKER_HOME"
  check "the worker's gateway key is its own, not kin's" own_gateway_key
  check "the worker's Claude settings hold no token and name nothing of kin's" settings_hold_no_token
  check "no GitHub token of the worker's is kin's or can push to $(kin_repos | paste -sd, -)" worker_tokens_read_only
  check "the worker environment's database has no links of its own (sqlite3, read-only)" worker_has_no_links
  check "kin-worker-server listens only on 127.0.0.1:$WORKER_PORT (ss, from root)" worker_server_listens_on_loopback_only
  check "kin-worker-server won't start while Kin is paused (ExecCondition)" \
    sh -c "systemctl show -P ExecCondition kin-worker-server.service | grep -q 'kin-worker may-start'"
  check "kin may only stop, start or restart the worker server and read workers' repositories" \
    grep -qxF "$SUDOERS_LINE" "$SUDOERS"
  check "KIN_WORKER_ENVIRONMENT_ID is kin-server's link to $WORKER_URL" kin_link_is_loopback
  # The probes above must fail for the right reason, not because the sandbox is broken.
  check "sandbox: can read its own home and Kin's build" \
    in_probe_sandbox /bin/sh -c "test -w $WORKER_HOME && test -r $BUILD/apps/server/dist/bin.mjs"
  if in_service "test -w $WORKER_HOME && test -r $BUILD/apps/server/dist/bin.mjs" >/dev/null 2>&1; then
    printf '  ✓ service: can read its own home and Kin'\''s build\n'
  else
    printf '  ✗ service: can'\''t read its own home and Kin'\''s build\n'
    FAILED=1
  fi
  if [ "$FAILED" -eq 1 ]; then
    say ""
    say "A worker could reach something it must not. Don't start workers until every line is ✓."
    exit 1
  fi
}

case "${1:-install}" in
  install) shift || true; cmd_install "$@" ;;
  setup) shift; cmd_setup "$@" ;;
  --dry-run) cmd_install --dry-run ;;
  link) cmd_link ;;
  check) cmd_check ;;
  run) shift; cmd_run "$@" ;;
  node) shift; cmd_node "$@" ;;
  upload-pack) shift; cmd_upload_pack "$@" ;;
  may-start) cmd_may_start ;;
  -h | --help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (setup, install, link, check, run)" ;;
esac
