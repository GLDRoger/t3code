#!/usr/bin/env bash
# Kin's worker environment: a plain T3 server as the `kin-worker` user, linked from kin-server.
# Workers' shells run there, in a sandbox that has no kin home, no owner home and no /tmp of
# kin's, so they can't read Kin's database, secrets, memory key or service.env, or run Kin's CLI.
#
#   sudo <root-owned clone>/ops/kin/host/kin-worker.sh [install] [--dry-run]   set up or repair
#   sudo kin-worker link                     (re)link kin-server; the timer runs it weekly
#   sudo kin-worker check                    the isolation checks, as a transcript
#   sudo kin-worker run [--] <command...>    a command as kin-worker, in the sandbox
#                                            (`t3 ...` runs Kin's build's CLI)
#
# `install` copies this script to /usr/local/sbin/kin-worker and never restarts kin-server.
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
  python3 -I -c 'import json, sys
print(json.load(open(sys.argv[1])).get("env", {}).get("ANTHROPIC_BASE_URL", ""))' \
    "$KIN_HOME/.claude/settings.json" 2>/dev/null || true
}

write_claude_settings() {
  local settings="$WORKER_HOME/.claude/settings.json" url
  if [ -f "$settings" ]; then
    say "$settings exists; check verifies it holds no token and names nothing of kin's."
    return 0
  fi
  url="$(gateway_url)"
  if ! [[ "$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]]; then
    say "No gateway URL for the worker's Claude settings: set KIN_WORKER_GATEWAY_URL=https://... and run this again."
    return 0
  fi
  install -d -m 0700 -o "$WORKER_USER" -g "$WORKER_USER" "$WORKER_HOME/.claude" "$(dirname "$GATEWAY_KEY")"
  # Only the gateway and a helper that reads the worker's own key; never kin's file or key.
  printf '{\n  "env": { "ANTHROPIC_BASE_URL": "%s" },\n  "apiKeyHelper": "cat %s"\n}\n' "$url" "$GATEWAY_KEY" >"$settings"
  chown "$WORKER_USER:$WORKER_USER" "$settings"
  chmod 0600 "$settings"
  say "Wrote $settings with gateway $url. Put kin-worker's own gateway key in $GATEWAY_KEY (mode 600)."
}

# kin may SIGKILL or restart the worker server, nothing else: the stop switch's last resort and
# update.sh's restart onto the new build. The kill command matches workerEnvironment.ts.
install_sudoers() {
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' \
    "# Installed by ops/kin/host/kin-worker.sh. kin may kill or restart the worker environment, nothing else." \
    "$KIN_USER ALL=(root) NOPASSWD: /usr/bin/systemctl kill -s SIGKILL kin-worker-server.service, /usr/bin/systemctl try-restart kin-worker-server.service" \
    >"$tmp"
  if cmp -s "$tmp" "$SUDOERS"; then
    rm -f "$tmp"
    return 0
  fi
  visudo -cqf "$tmp" || { rm -f "$tmp"; die "the sudoers entry didn't validate."; }
  run_cmd install -m 0440 -o root -g root "$tmp" "$SUDOERS"
  rm -f "$tmp"
}

cmd_install() {
  if [ "${1:-}" = --dry-run ]; then DRY_RUN=1; fi
  if [ "$DRY_RUN" -eq 0 ]; then
    [ "$(uname -s)" = Linux ] || die "needs Linux with systemd."
    need_root install
    refuse_unsafe_source
  fi
  id -u "$KIN_USER" >/dev/null 2>&1 || die "no $KIN_USER user yet: run ops/kin/host/setup.sh first."
  refuse_unsafe_users

  # 1. The worker user, with a home only it can read. Kin's home gets the same.
  if id -u "$WORKER_USER" >/dev/null 2>&1; then
    say "User $WORKER_USER exists."
  else
    run_cmd useradd --create-home --home-dir "$WORKER_HOME" --shell /bin/bash "$WORKER_USER"
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    ensure_mode_700 "$KIN_HOME"
    ensure_mode_700 "$WORKER_HOME"
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
  local settings="$WORKER_HOME/.t3/userdata/settings.json"
  if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$settings" ]; then
    install -d -m 0700 -o "$WORKER_USER" -g "$WORKER_USER" "$WORKER_HOME/.t3" "$WORKER_HOME/.t3/userdata"
    printf '{\n  "linkedEnvironmentsEnabled": true\n}\n' >"$settings"
    chown "$WORKER_USER:$WORKER_USER" "$settings"
    chmod 0600 "$settings"
    say "Wrote $settings."
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
  check "gh" in_sandbox gh --version
  check "mise" in_sandbox mise --version
  check "python3 (check's probes use it)" in_sandbox python3 --version
  check "Claude Code CLI" in_sandbox claude --version
  check "Codex CLI" in_sandbox codex --version
  check "gh signed in (the workers' own GitHub token)" in_sandbox gh auth status
  check "kin-worker's own gateway key at $GATEWAY_KEY" test -s "$GATEWAY_KEY"
  check "kin-worker-server running" systemctl is-active kin-worker-server.service
  check "weekly relink timer" systemctl is-active kin-worker-link.timer
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

# --- check -----------------------------------------------------------------------------------

live_pid() { [ -n "$1" ] && [ "$1" != 0 ] && kill -0 "$1"; }

# Runs a probe as kin-worker inside the running server's own mount namespace, which is where
# workers' shells run. cgroup rules (SocketBindDeny, IPAddressDeny, limits) don't follow nsenter;
# those are probed in a fresh `run` sandbox, which `sandbox_matches` shows is the same.
in_service() {
  nsenter --target "$SERVICE_PID" --mount -- \
    setpriv --reuid="$(id -u "$WORKER_USER")" --regid="$(id -g "$WORKER_USER")" --clear-groups --no-new-privs -- \
    env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" sh -c "cd / && $1" </dev/null
}
as_login() { sudo -u "$WORKER_USER" -H sh -c "$1" </dev/null; }

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

# A gateway key from a user's Claude settings: its apiKeyHelper's output, else an inline key.
key_hash() {
  local user="$1" settings="$2" helper key
  [ -f "$settings" ] || return 0
  helper="$(python3 -I -c 'import json, sys
print(json.load(open(sys.argv[1])).get("apiKeyHelper", ""))' "$settings" 2>/dev/null || true)"
  if [ -n "$helper" ]; then
    if [ "$user" = "$WORKER_USER" ]; then key="$(in_sandbox sh -c "$helper" 2>/dev/null || true)"; else
      key="$(as_kin sh -c "$helper" 2>/dev/null || true)"
    fi
  else
    key="$(python3 -I -c 'import json, sys
env = json.load(open(sys.argv[1])).get("env", {})
print(env.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_AUTH_TOKEN") or "")' "$settings" 2>/dev/null || true)"
  fi
  if [ -n "$key" ]; then printf '%s' "$key" | sha256sum | cut -d' ' -f1; fi
}
own_gateway_key() {
  local mine theirs
  mine="$(key_hash "$WORKER_USER" "$WORKER_HOME/.claude/settings.json")"
  theirs="$(key_hash "$KIN_USER" "$KIN_HOME/.claude/settings.json")"
  [ -n "$mine" ] && [ "$mine" != "$theirs" ]
}
# The worker's settings carry no token inline and name nothing of kin's.
settings_hold_no_token() {
  local settings="$WORKER_HOME/.claude/settings.json"
  [ -f "$settings" ] || return 1
  ! grep -q "$KIN_HOME" "$settings" || return 1
  ! grep -Eq 'sk-ant|gh[opsu]_[A-Za-z0-9]' "$settings" || return 1
  python3 -I -c 'import json, re, sys
data = json.load(open(sys.argv[1]))
env = data.get("env", {})
sys.exit(1 if not data.get("apiKeyHelper") or any(re.search("KEY|TOKEN|SECRET|PASSWORD", k, re.I) for k in env) else 0)' "$settings"
}
own_github_login() {
  local mine theirs mine_token theirs_token
  mine="$(in_sandbox gh api user --jq .login 2>/dev/null || true)"
  theirs="$(as_kin gh api user --jq .login 2>/dev/null || true)"
  mine_token="$(in_sandbox gh auth token 2>/dev/null | sha256sum | cut -d' ' -f1)"
  theirs_token="$(as_kin gh auth token 2>/dev/null | sha256sum | cut -d' ' -f1)"
  [ -n "$mine" ] && [ "$mine" != "$theirs" ] && [ "$mine_token" != "$theirs_token" ]
}
# Kin's repository as owner/repo, from kin's clone that update.sh builds.
kin_repo_slug() {
  local repo url
  repo="$(sed -n 's/^KIN_REPO=//p' "$KIN_HOME/.config/kin/kin-server.env" 2>/dev/null | tail -n1)"
  url="$(as_kin git -C "${repo:-$KIN_HOME/t3code}" remote get-url origin 2>/dev/null || true)"
  printf '%s\n' "$url" | sed -n 's#^.*github\.com[:/]\([^/]*/[^/]*\)$#\1#p' | sed 's/\.git$//'
}
# The worker's token can't push to Kin's `kin` or `main`: no push access at all, or each branch
# under a ruleset rule that blocks direct pushes, which the bot can never bypass.
cant_push_kin() {
  local slug branch ids id blocked
  slug="$(kin_repo_slug)"
  [ -n "$slug" ] || return 1
  [ "$(in_sandbox gh api "repos/$slug" --jq .permissions.push 2>/dev/null || true)" = true ] || return 0
  for branch in kin main; do
    ids="$(in_sandbox gh api "repos/$slug/rules/branches/$branch" \
      --jq '.[] | select(.type == "update" or .type == "pull_request") | .ruleset_id' 2>/dev/null || true)"
    blocked=0
    for id in $(printf '%s\n' "$ids" | sort -u); do
      if [ "$(in_sandbox gh api "repos/$slug/rulesets/$id?includes_parents=true" --jq .current_user_can_bypass 2>/dev/null)" = never ]; then
        blocked=1
      fi
    done
    [ "$blocked" -eq 1 ] || return 1
  done
}
links_json() {
  python3 -I -c 'import json, sys
links = json.load(sys.stdin)
mode = sys.argv[1]
if mode == "none":
    sys.exit(0 if links == [] else 1)
match = [l for l in links if l.get("environmentId") == sys.argv[2]]
sys.exit(0 if len(match) == 1 and sys.argv[3] in match[0].get("urls", []) else 1)' "$@"
}
worker_has_no_links() {
  in_sandbox /usr/local/sbin/kin-worker node environment list --base-dir "$WORKER_HOME/.t3" --json |
    links_json none
}
kin_link_is_loopback() {
  local id
  id="$(service_env_value KIN_WORKER_ENVIRONMENT_ID)"
  [ -n "$id" ] || return 1
  kin_cli environment list --base-dir "$KIN_HOME/.t3" --json | links_json one "$id" "$WORKER_URL"
}
refuses() {
  in_sandbox curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$1" "${@:3}" "$2" | grep -Eqx '401|403'
}

# Each probe must fail. They run as kin-worker three ways: inside the running server's mount
# namespace, in a fresh sandbox like the server's, and as a plain login, where kin's mode-700
# home is the second wall.
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
    check "sandbox: can't $label" sh -c "! /usr/local/sbin/kin-worker run -- sh -c '$command' </dev/null"
    if as_login "$command" >/dev/null 2>&1; then
      printf '  ✗ login:   can %s\n' "$label"
      FAILED=1
    else printf '  ✓ login:   can'\''t %s\n' "$label"; fi
  done
  check "sandbox: can't list Kin's sessions with the auth CLI" \
    sh -c "! /usr/local/sbin/kin-worker run t3 auth session list --base-dir $KIN_HOME/.t3 </dev/null"
  check "sandbox: can't change a lead's worker projects (kin lead projects, H3)" \
    sh -c "! /usr/local/sbin/kin-worker run -- env KIN_ENABLED=true /usr/local/sbin/kin-worker node kin lead list --base-dir $KIN_HOME/.t3 </dev/null"
  check "sandbox: can't sudo" sh -c "! /usr/local/sbin/kin-worker run -- sudo -n true </dev/null"
  check "sandbox: binding 127.0.0.1:$KIN_PORT is refused" in_sandbox python3 -I -c "$BIND_PROBE" 127.0.0.1 "$KIN_PORT"
  check "sandbox: binding [::1]:$KIN_PORT is refused" in_sandbox python3 -I -c "$BIND_PROBE" ::1 "$KIN_PORT"
  check "sandbox: can't reach cloud metadata (169.254.169.254)" \
    sh -c "! /usr/local/sbin/kin-worker run -- curl -s -m 5 -o /dev/null http://169.254.169.254/ </dev/null"
  check "sandbox: DNS still resolves (github.com)" in_sandbox getent hosts github.com
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
  check "the worker's GitHub login and token are its own, not kin's" own_github_login
  check "the worker's GitHub token can't push to Kin's kin or main ($(kin_repo_slug))" cant_push_kin
  check "the worker environment has no links of its own" worker_has_no_links
  check "KIN_WORKER_ENVIRONMENT_ID is kin-server's link to $WORKER_URL" kin_link_is_loopback
  # The probes above must fail for the right reason, not because the sandbox is broken.
  check "sandbox: can read its own home and Kin's build" \
    /usr/local/sbin/kin-worker run -- sh -c "test -w $WORKER_HOME && test -r $BUILD/apps/server/dist/bin.mjs"
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
  --dry-run) cmd_install --dry-run ;;
  link) cmd_link ;;
  check) cmd_check ;;
  run) shift; cmd_run "$@" ;;
  node) shift; cmd_node "$@" ;;
  -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (install, link, check, run)" ;;
esac
