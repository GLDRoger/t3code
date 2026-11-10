#!/usr/bin/env bash
# Kin's worker environment: a plain T3 server as the `kin-worker` user, linked from kin-server.
# Workers' shells run there, in a sandbox that has no kin home, no owner home and no /tmp of
# kin's, so they can't read Kin's database, secrets, memory key or service.env, or run Kin's CLI.
#
#   sudo ops/kin/host/kin-worker.sh [install] [--dry-run]   set up or repair; idempotent
#   sudo kin-worker link                                     (re)link kin-server; the timer runs it weekly
#   sudo kin-worker check                                    the isolation checks, as a transcript
#   sudo kin-worker run [--] <command...>                    a command as kin-worker, in the sandbox
#                                                            (`t3 ...` runs Kin's build's CLI)
#
# `install` copies this script to /usr/local/sbin/kin-worker and never restarts kin-server.
set -euo pipefail

KIN_USER=kin
WORKER_USER=kin-worker
KIN_HOME=/home/$KIN_USER
WORKER_HOME=/home/$WORKER_USER
WORKER_PORT=3874
WORKER_URL=http://127.0.0.1:$WORKER_PORT
BUILD=/opt/kin-current
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS=(kin-worker-server.service kin-worker-reload.path kin-worker-reload.service kin-worker-link.service kin-worker-link.timer)
WORKER_PATH="$WORKER_HOME/.local/bin:$WORKER_HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin"
# The sandbox. Keep in step with kin-worker-server.service; `check` compares them.
SANDBOX=(
  -p ProtectHome=tmpfs
  -p "BindPaths=$WORKER_HOME"
  -p "BindReadOnlyPaths=$KIN_HOME/kin-current:$BUILD"
  -p PrivateTmp=yes
  -p ProtectProc=invisible
  -p NoNewPrivileges=yes
  -p ProtectSystem=full
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

# `run [--] <command...>`: a command as kin-worker with the worker unit's sandbox.
cmd_run() {
  need_root run
  if [ "${1:-}" = -- ]; then shift; fi
  [ $# -gt 0 ] || die "run needs a command"
  if [ "$1" = t3 ]; then
    shift
    set -- /usr/local/sbin/kin-worker node "$@"
  fi
  local io=--pipe
  if [ -t 0 ] && [ -t 1 ]; then io=--pty; fi
  systemd-run --quiet --wait --collect "$io" \
    --uid="$WORKER_USER" --gid="$WORKER_USER" \
    --working-directory="$WORKER_HOME" \
    --setenv=HOME="$WORKER_HOME" --setenv=PATH="$WORKER_PATH" \
    "${SANDBOX[@]}" -- "$@"
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

ensure_mode_700() {
  if [ "$(stat -c %a "$1")" != 700 ]; then run_cmd chmod 0700 "$1"; fi
}

cmd_install() {
  if [ "${1:-}" = --dry-run ]; then DRY_RUN=1; fi
  if [ "$DRY_RUN" -eq 0 ]; then
    [ "$(uname -s)" = Linux ] || die "needs Linux with systemd."
    need_root install
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

  # 2. This script, the units and the build's mount point.
  if ! cmp -s "$SCRIPT_DIR/kin-worker.sh" /usr/local/sbin/kin-worker 2>/dev/null; then
    run_cmd install -m 0755 -o root -g root "$SCRIPT_DIR/kin-worker.sh" /usr/local/sbin/kin-worker
  fi
  local changed=0 unit
  for unit in "${UNITS[@]}"; do
    if ! cmp -s "$SCRIPT_DIR/$unit" "/etc/systemd/system/$unit" 2>/dev/null; then
      run_cmd install -m 0644 -o root -g root "$SCRIPT_DIR/$unit" "/etc/systemd/system/$unit"
      changed=1
    fi
  done
  if [ ! -d "$BUILD" ]; then run_cmd install -d -m 0755 -o root -g root "$BUILD"; fi
  if [ "$changed" -eq 1 ]; then run_cmd systemctl daemon-reload; fi

  # 3. Linked environments on in the worker environment, so kin-server's link is accepted.
  local settings="$WORKER_HOME/.t3/userdata/settings.json"
  if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$settings" ]; then
    install -d -m 0700 -o "$WORKER_USER" -g "$WORKER_USER" "$WORKER_HOME/.t3" "$WORKER_HOME/.t3/userdata"
    printf '{\n  "linkedEnvironmentsEnabled": true\n}\n' >"$settings"
    chown "$WORKER_USER:$WORKER_USER" "$settings"
    chmod 0600 "$settings"
    say "Wrote $settings."
  fi

  # 4. Claude's gateway settings, copied once. The worker gets the gateway, never kin's files.
  if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$WORKER_HOME/.claude/settings.json" ] && [ -f "$KIN_HOME/.claude/settings.json" ]; then
    install -d -m 0700 -o "$WORKER_USER" -g "$WORKER_USER" "$WORKER_HOME/.claude"
    install -m 0600 -o "$WORKER_USER" -g "$WORKER_USER" "$KIN_HOME/.claude/settings.json" "$WORKER_HOME/.claude/settings.json"
    say "Copied $KIN_HOME/.claude/settings.json to $WORKER_HOME/.claude/settings.json."
  fi

  # 5. Start what can start.
  run_cmd systemctl enable kin-worker-server.service kin-worker-reload.path kin-worker-link.timer
  run_cmd systemctl start kin-worker-reload.path kin-worker-link.timer
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

as_worker() { sudo -u "$WORKER_USER" -H env PATH="$WORKER_PATH" "$@"; }
as_kin() {
  sudo -u "$KIN_USER" -H env \
    PATH="$KIN_HOME/.local/bin:$KIN_HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin" "$@"
}
kin_cli() {
  local version
  version="$(node_version_of "$KIN_HOME/kin-current")"
  as_kin mise exec "node@$version" -- node "$KIN_HOME/kin-current/apps/server/dist/bin.mjs" "$@"
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
  check "git" as_worker git --version
  check "gh" as_worker gh --version
  check "mise" as_worker mise --version
  check "Claude Code CLI" as_worker claude --version
  check "Codex CLI" as_worker codex --version
  check "gh signed in (the workers' own GitHub token)" as_worker gh auth status
  check "Claude settings name nothing in $KIN_HOME" sh -c "! grep -q '$KIN_HOME' '$WORKER_HOME/.claude/settings.json'"
  check "kin-worker-server running" systemctl is-active kin-worker-server.service
  check "reload on Kin's new build" systemctl is-active kin-worker-reload.path
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
  [ -n "$id" ] || die "linking printed no environment id: $linked"
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

# Each probe must fail. They run as kin-worker twice: in the sandbox workers' shells run in, and
# as a plain login, where kin's mode-700 home is the second wall.
cmd_check() {
  need_root check
  local owner="${SUDO_USER:-}" probes kin_pid kin_url
  kin_url="${KIN_URL:-http://127.0.0.1:3773}"
  kin_pid="$(systemctl --user -M "$KIN_USER@" show -P MainPID kin-server 2>/dev/null || echo 0)"
  probes=(
    "read Kin's database|cat $KIN_HOME/.t3/userdata/statev2.sqlite"
    "list Kin's secrets|ls $KIN_HOME/.t3/userdata/secrets"
    "list ~kin/.config/kin (memory key, APNs key, GitHub App key)|ls $KIN_HOME/.config/kin"
    "read service.env|cat $KIN_HOME/.t3/service.env"
    "read kin's Claude login|ls $KIN_HOME/.claude"
    "read kin's Codex login|ls $KIN_HOME/.codex"
    "read kin-server's environment|cat /proc/$kin_pid/environ"
  )
  if [ -n "$owner" ] && [ "$owner" != root ]; then
    probes+=("list the owner's home ($owner)|ls /home/$owner")
  fi
  FAILED=0
  say ""
  say "Isolation: each line is something a worker's shell must not be able to do."
  local probe label command
  for probe in "${probes[@]}"; do
    label="${probe%%|*}"
    command="${probe#*|}"
    check "sandbox: can't $label" sh -c "! /usr/local/sbin/kin-worker run -- sh -c '$command' </dev/null"
    check "login:   can't $label" sh -c "! sudo -u '$WORKER_USER' -H sh -c '$command' </dev/null"
  done
  check "sandbox: can't list Kin's sessions with the auth CLI" \
    sh -c "! /usr/local/sbin/kin-worker run t3 auth session list --base-dir $KIN_HOME/.t3 </dev/null"
  check "sandbox: can't change a lead's worker projects (kin lead projects, H3)" \
    sh -c "! /usr/local/sbin/kin-worker run -- env KIN_ENABLED=true /usr/local/sbin/kin-worker node kin lead list --base-dir $KIN_HOME/.t3 </dev/null"
  check "sandbox: can't sudo" sh -c "! /usr/local/sbin/kin-worker run -- sudo -n true </dev/null"
  check "sandbox: Kin's /mcp refuses a call with no credential ($kin_url)" \
    sh -c "/usr/local/sbin/kin-worker run -- curl -s -o /dev/null -w '%{http_code}' -X POST $kin_url/mcp </dev/null | grep -Eqx '401|403'"
  # The probes above must fail for the right reason, not because the sandbox is broken.
  check "sandbox: can read its own home and Kin's build" \
    /usr/local/sbin/kin-worker run -- sh -c "test -w $WORKER_HOME && test -r $BUILD/apps/server/dist/bin.mjs"
  local pair
  for pair in ProtectHome=tmpfs PrivateTmp=yes ProtectProc=invisible NoNewPrivileges=yes ProtectSystem=full; do
    check "kin-worker-server runs with $pair, like the sandbox" \
      sh -c "[ \"\$(systemctl show -P ${pair%%=*} kin-worker-server.service)\" = ${pair#*=} ]"
  done
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
