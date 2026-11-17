#!/usr/bin/env bash
# Removes what kin-worker.sh installed on the Kin host, now that Kin has no workers, and lists what
# the workers and the App's old merge and webhook setup left in kin's own files for you to remove.
# Kin's GitHub App, its kin-github-app keyring item and its env lines stay: agents work as the App.
# Run as root, from a root-owned clone (the one kin-worker.sh ran from, /root/kin-ops):
#
#   sudo /root/kin-ops/ops/kin/host/retire-workers.sh          prints what it would do
#   sudo /root/kin-ops/ops/kin/host/retire-workers.sh --yes    does it
#
# Refuses unless kin-server runs a build that no longer starts workers. Never touches kin's home,
# ~/.t3, the database, service.env, the keyring, backups or the build folders: those steps are
# printed for you to run.
set -euo pipefail

# The merges of the PRs that stopped Kin using workers, then the App's webhooks and merge key.
RETIRED_IN=13ffc91a413d341c6e05d5629d98d6fa120380e7
HOOKS_RETIRED_IN=48f6111f62205415e34d6e3795ee43deda0af678
KIN_USER=kin
KIN_HOME=/home/$KIN_USER
REPO=${KIN_REPO:-$KIN_HOME/t3code}
WORKER_USER=kin-worker
WORKER_HOME=/home/$WORKER_USER
UNITS=(kin-worker-server.service kin-worker-link.timer kin-worker-link.service
  kin-worker-reload.path kin-worker-reload.service)
FILES=(/etc/sudoers.d/kin-worker /usr/local/sbin/kin-worker)
MOUNT=/opt/kin-current

say() { echo "retire-workers.sh: $*" >&2; }
die() {
  say "$*"
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run it as root (sudo)."
case "${1:-}" in
  --yes) apply=1 ;;
  "") apply=0 ;;
  *) die "unknown argument '$1'; the only one is --yes." ;;
esac

# kin-server must already run without workers, or it would start them again.
build="$(readlink "$KIN_HOME/kin-current" 2>/dev/null || true)"
sha="${build##*/}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "can't tell which build kin-server runs ($KIN_HOME/kin-current -> '${build:-nothing}'). Nothing changed."
runuser -u "$KIN_USER" -- git -C "$REPO" merge-base --is-ancestor "$RETIRED_IN" "$sha" 2>/dev/null ||
  die "kin-server runs $sha, which still uses workers (or $REPO doesn't know ${RETIRED_IN:0:12}). Update Kin first (as kin: ~/t3code/ops/kin/host/update.sh), then run this again. Nothing changed."
say "kin-server runs $sha, which no longer starts workers."

# What only you can remove: kin's own settings and keyring, and Kin's state. Printed, never run.
leftovers() {
  say "left in kin's own files, which this never edits; in a kin shell (sudo -iu $KIN_USER):"
  echo "  - kin environment list, then kin environment unlink <id> for the worker server at 127.0.0.1:3874" >&2
  echo "  - delete the KIN_WORKER_* lines from ~/.t3/service.env" >&2
  echo "  - then restart kin-server: systemctl --user restart kin-server" >&2
  echo "  - keep KIN_GITHUB_APP_ID, KIN_GITHUB_BOT_LOGIN and the kin-github-app keyring item: agents work on GitHub as the App" >&2
  if runuser -u "$KIN_USER" -- git -C "$REPO" merge-base --is-ancestor "$HOOKS_RETIRED_IN" "$sha" 2>/dev/null; then
    echo "  - delete the owner-merge key, which nothing reads now: secret-tool clear service kin-owner-merge" >&2
    echo "  - in Kin, Settings → Scheduled tasks: delete \"Kin · GitHub App · …\" (it already starts nothing)" >&2
    echo "  - connect your own GitHub from the phone (Settings → Connections → GitHub): Kin watches your repos with it" >&2
  else
    say "this build still merges with the owner-merge key; update Kin again before removing it."
  fi
}

plan=()
for unit in "${UNITS[@]}"; do
  [ -e "/etc/systemd/system/$unit" ] && plan+=("stop, disable and delete the unit $unit")
done
for file in "${FILES[@]}"; do
  [ -e "$file" ] && plan+=("delete $file")
done
if [ -d "$MOUNT" ]; then
  if mountpoint -q "$MOUNT"; then
    plan+=("unmount and delete the empty folder $MOUNT")
  else
    plan+=("delete the empty folder $MOUNT")
  fi
fi
id "$WORKER_USER" >/dev/null 2>&1 && plan+=("delete the user $WORKER_USER and its home $WORKER_HOME, with its repositories and T3 state")

if [ "${#plan[@]}" -eq 0 ]; then
  say "nothing of the workers is left on this host."
  leftovers
  exit 0
fi
say "this will:"
for step in "${plan[@]}"; do echo "  - $step" >&2; done
say "kin's home, ~/.t3, the database, service.env, the keyring, backups and builds stay as they are."
if [ "$apply" -eq 0 ]; then
  say "nothing changed. Run it again with --yes to do it."
  leftovers
  exit 0
fi

for unit in "${UNITS[@]}"; do
  [ -e "/etc/systemd/system/$unit" ] || continue
  systemctl disable --now "$unit" 2>/dev/null || systemctl stop "$unit" 2>/dev/null || true
  rm -f "/etc/systemd/system/$unit"
  say "removed $unit."
done
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true
for file in "${FILES[@]}"; do
  [ -e "$file" ] || continue
  rm -f "$file"
  say "deleted $file."
done
if [ -d "$MOUNT" ]; then
  if mountpoint -q "$MOUNT"; then umount "$MOUNT" || die "couldn't unmount $MOUNT; the rest is left as it is."; fi
  rmdir "$MOUNT" || die "$MOUNT isn't empty, so it stays; look inside, then delete it by hand."
  say "deleted $MOUNT."
fi
if id "$WORKER_USER" >/dev/null 2>&1; then
  [ "$(getent passwd "$WORKER_USER" | cut -d: -f6)" = "$WORKER_HOME" ] ||
    die "$WORKER_USER's home isn't $WORKER_HOME, so the user stays; delete it by hand."
  loginctl disable-linger "$WORKER_USER" 2>/dev/null || true
  loginctl terminate-user "$WORKER_USER" 2>/dev/null || true
  userdel --remove "$WORKER_USER" || die "couldn't delete $WORKER_USER; see the line above."
  say "deleted the user $WORKER_USER and $WORKER_HOME."
fi
say "done."
leftovers
