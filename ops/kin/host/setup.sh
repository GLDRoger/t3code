#!/usr/bin/env bash
# Prepares a Linux machine to be the Kin host. Run as root (sudo) from any clone of the repo.
# Idempotent: re-running changes nothing that is already in place and never restarts a
# running server. Only the `kin` user's home is touched, never the invoking user's ~/.t3.
#
#   sudo ops/kin/host/setup.sh [--dry-run] [--user kin] [--checkout /home/kin/t3code]
#
# --checkout is kin's source clone. Builds live in ~kin/kin-builds; update.sh makes them.
set -euo pipefail

KIN_USER=kin
CHECKOUT=""
DRY_RUN=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIG_ARGS=("$@")

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --user) KIN_USER="${2:?--user needs a name}"; shift ;;
    --checkout) CHECKOUT="${2:?--checkout needs a path}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
refuse() { echo "Refusing: $*" >&2; exit 1; }
# Prints the command, then runs it unless --dry-run.
run() {
  printf '+ %s\n' "$*"
  if [ "$DRY_RUN" -eq 0 ]; then "$@"; fi
}

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(uname -s)" = Linux ] || { echo "setup.sh needs Linux with systemd." >&2; exit 1; }
  [ "$(id -u)" -eq 0 ] || { echo "Run setup.sh as root: sudo $0 ${ORIG_ARGS[*]}" >&2; exit 1; }
  command -v systemctl >/dev/null || { echo "systemctl not found." >&2; exit 1; }
elif [ "$(uname -s)" != Linux ]; then
  say "Dry run on $(uname -s): showing the Linux actions only."
fi

user_exists() { id -u "$KIN_USER" >/dev/null 2>&1; }
home_of() {
  if command -v getent >/dev/null; then getent passwd "$1" | cut -d: -f6; fi
}

# 1. The kin user.
CREATED=0
if user_exists; then
  say "User $KIN_USER exists."
else
  run useradd --create-home --shell /bin/bash "$KIN_USER"
  CREATED=1
fi
KIN_HOME="/home/$KIN_USER"
if user_exists; then KIN_HOME="$(home_of "$KIN_USER")"; fi
KIN_UID="$(id -u "$KIN_USER" 2>/dev/null || echo '<uid>')"
CHECKOUT="${CHECKOUT:-$KIN_HOME/t3code}"
CURRENT="$KIN_HOME/kin-current"

# Guards: this script manages a dedicated, unprivileged kin account only.
[ "$KIN_USER" != root ] || refuse "$KIN_USER is root. Use a dedicated user."
[ "$KIN_HOME" != "${HOME:-}" ] || refuse "$KIN_USER's home ($KIN_HOME) is this shell's \$HOME."
for invoker in "${SUDO_USER:-}" "$(id -un)"; do
  if [ -z "$invoker" ] || [ "$invoker" = root ]; then continue; fi
  [ "$KIN_HOME" != "$(home_of "$invoker")" ] || refuse "$KIN_USER's home ($KIN_HOME) is $invoker's home."
done
login_uid="$(cat /proc/self/loginuid 2>/dev/null || true)"
if [ -n "$login_uid" ] && [ "$login_uid" != 4294967295 ] && command -v getent >/dev/null; then
  login_home="$(getent passwd "$login_uid" | cut -d: -f6)"
  [ "$KIN_HOME" != "$login_home" ] || refuse "$KIN_USER's home ($KIN_HOME) is the logged-in user's home."
fi
if user_exists && [ "$CREATED" -eq 0 ]; then
  [ "$KIN_UID" -ge 1000 ] || refuse "$KIN_USER has uid $KIN_UID, a system account."
  for group in $(id -nG "$KIN_USER"); do
    case "$group" in sudo | wheel | admin) refuse "$KIN_USER is in the $group group." ;; esac
  done
fi
case "$CHECKOUT" in
  "$KIN_HOME"/*) ;;
  *) refuse "--checkout $CHECKOUT is not under $KIN_HOME." ;;
esac
if [ -e "$CHECKOUT" ] && [ "$(uname -s)" = Linux ] && [ "$(stat -c %U "$CHECKOUT")" != "$KIN_USER" ]; then
  refuse "$CHECKOUT is not owned by $KIN_USER."
fi

as_kin() {
  sudo -u "$KIN_USER" -H env \
    XDG_RUNTIME_DIR="/run/user/$KIN_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$KIN_UID/bus" \
    PATH="$KIN_HOME/.local/bin:$KIN_HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}
# Creates a directory owned by kin when it is missing; leaves an existing one's mode alone.
ensure_dir() {
  if [ -d "$2" ]; then return; fi
  run install -d -m "$1" -o "$KIN_USER" -g "$KIN_USER" "$2"
}

# 2. Start kin's user manager at boot, with nobody logged in.
run loginctl enable-linger "$KIN_USER"
run systemctl start "user@$KIN_UID.service"

# 3. Never sleep.
run systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# 4. Units and their environment.
NODE_VERSION=26
if [ -f "$CHECKOUT/package.json" ]; then
  engines="$(sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' "$CHECKOUT/package.json" | head -n1)"
  NODE_VERSION="${engines:-$NODE_VERSION}"
fi
# update.sh rewrites this from the build it installs.
if [ -f "$CURRENT/package.json" ]; then
  engines="$(sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' "$CURRENT/package.json" | head -n1)"
  NODE_VERSION="${engines:-$NODE_VERSION}"
fi
UNIT_DIR="$KIN_HOME/.config/systemd/user"
CONFIG_DIR="$KIN_HOME/.config/kin"
ensure_dir 0700 "$KIN_HOME/.config"
ensure_dir 0755 "$KIN_HOME/.config/systemd"
ensure_dir 0755 "$UNIT_DIR"
ensure_dir 0700 "$CONFIG_DIR"

UNIT_CHANGED=0
for unit in kin-server.service kin-backup.service kin-backup.timer; do
  if [ -f "$UNIT_DIR/$unit" ] && cmp -s "$SCRIPT_DIR/$unit" "$UNIT_DIR/$unit"; then
    say "$unit is current."
  else
    run install -m 0644 -o "$KIN_USER" -g "$KIN_USER" "$SCRIPT_DIR/$unit" "$UNIT_DIR/$unit"
    if [ "$unit" = kin-server.service ]; then UNIT_CHANGED=1; fi
  fi
done

# Keep in step with update.sh, which writes the same file.
ENV_FILE="$CONFIG_DIR/kin-server.env"
ENV_CONTENT="KIN_ENABLED=true
PATH=$KIN_HOME/.local/bin:$KIN_HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
KIN_REPO=$CHECKOUT
KIN_CHECKOUT=$CURRENT
KIN_NODE_VERSION=$NODE_VERSION"
if [ -f "$ENV_FILE" ] && [ "$(cat "$ENV_FILE")" = "$ENV_CONTENT" ]; then
  say "$ENV_FILE is current."
else
  printf '+ write %s:\n%s\n' "$ENV_FILE" "$ENV_CONTENT" | sed '2,$s/^/    /'
  if [ "$DRY_RUN" -eq 0 ]; then
    tmp="$(mktemp)"
    printf '%s\n' "$ENV_CONTENT" >"$tmp"
    install -m 0600 -o "$KIN_USER" -g "$KIN_USER" "$tmp" "$ENV_FILE"
    rm -f "$tmp"
  fi
  UNIT_CHANGED=1
fi

run as_kin systemctl --user daemon-reload
run as_kin systemctl --user enable kin-server.service
run as_kin systemctl --user enable --now kin-backup.timer
if [ -f "$CURRENT/apps/server/dist/bin.mjs" ]; then
  # `start` is a no-op for a running server; changed settings wait for a planned restart.
  run as_kin systemctl --user start kin-server.service
else
  say "No build at $CURRENT yet: as $KIN_USER, run $CHECKOUT/ops/kin/host/update.sh (see README.md)."
fi

# 5. Checklist.
say ""
say "Kin host checklist ($KIN_USER, $KIN_HOME)"
FAILED=0
check() {
  local label="$1"
  shift
  if [ "$DRY_RUN" -eq 1 ] && ! { [ "$(id -u)" -eq 0 ] && user_exists; }; then
    printf '  ? %s (would check: %s)\n' "$label" "$*"
  elif "$@" >/dev/null 2>&1; then
    printf '  ✓ %s\n' "$label"
  else
    printf '  ✗ %s\n' "$label"
    FAILED=1
  fi
}
node_major="${NODE_VERSION%%.*}"
check "git" as_kin git --version
check "gh" as_kin gh --version
check "git-filter-repo" as_kin git filter-repo --version
check "gitleaks" as_kin gitleaks version
check "sqlite3 (backups)" as_kin sqlite3 --version
check "mise" as_kin mise --version
check "Node $NODE_VERSION via mise" as_kin sh -c "mise exec node@$NODE_VERSION -- node --version | grep -q '^v$node_major\\.'"
check "vp" as_kin vp --version
check "Claude Code CLI" as_kin claude --version
check "Codex CLI" as_kin codex --version
check "clone at $CHECKOUT on branch kin" as_kin sh -c "[ \"\$(git -C '$CHECKOUT' branch --show-current)\" = kin ]"
check "clone has .env (T3 Connect build config)" test -f "$CHECKOUT/.env"
check "a build is current ($CURRENT)" test -f "$CURRENT/apps/server/dist/bin.mjs"
check "linger on" sh -c "loginctl show-user '$KIN_USER' -p Linger | grep -q 'Linger=yes'"
check "sleep targets masked" sh -c "[ \"\$(systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target | sort -u)\" = masked ]"
check "kin-server enabled" as_kin systemctl --user is-enabled kin-server.service
check "kin-server running" as_kin systemctl --user is-active kin-server.service
check "backup timer enabled" as_kin systemctl --user is-enabled kin-backup.timer
check "backup destination set (~/.config/kin/backup.env)" test -f "$CONFIG_DIR/backup.env"

if [ "$UNIT_CHANGED" -eq 1 ] && [ "$DRY_RUN" -eq 0 ] && as_kin systemctl --user is-active --quiet kin-server.service; then
  say ""
  say "Settings changed. Apply them at a quiet moment: sudo -u $KIN_USER XDG_RUNTIME_DIR=/run/user/$KIN_UID systemctl --user restart kin-server"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  say ""
  say "Dry run: nothing was changed."
  exit 0
fi
exit "$FAILED"
