#!/usr/bin/env bash
# Backs up the Kin server's state to an encrypted volume and keeps 14 days.
# Run as the kin user (kin-backup.timer does this nightly). Reads the kin user's
# ~/.t3, resolved from the password database, never the invoking user's.
#
#   backup.sh --dest /mnt/backup/kin [--user kin] [--i-know-dest-is-encrypted]
#
# Writes kin-YYYY-MM-DD/userdata/ (all of ~/.t3/userdata except logs and rebuildable
# files, with statev2.sqlite as a consistent snapshot) and kin-YYYY-MM-DD/service.env.
set -euo pipefail

KIN_USER=kin
DEST=""
ASSUME_ENCRYPTED=0
KEEP_DAYS=14

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a directory}"; shift ;;
    --user) KIN_USER="${2:?--user needs a name}"; shift ;;
    --i-know-dest-is-encrypted) ASSUME_ENCRYPTED=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() { echo "backup.sh: $*" >&2; exit 1; }

[ -n "$DEST" ] || die "--dest is required."
[ "$(id -un)" = "$KIN_USER" ] || die "run this as $KIN_USER, not $(id -un)."
KIN_HOME="$(getent passwd "$KIN_USER" | cut -d: -f6)"
[ -n "$KIN_HOME" ] || die "no home directory for $KIN_USER."
BASE="$KIN_HOME/.t3"
USERDATA="$BASE/userdata"
DB="$USERDATA/statev2.sqlite"
[ -f "$DB" ] || die "no database at $DB."
[ -d "$DEST" ] || die "destination $DEST does not exist."
case "$DEST" in *"'"*) die "destination $DEST contains a single quote." ;; esac

mount_target() { findmnt --noheadings --output TARGET --target "$1" 2>/dev/null; }
# The backing device, without a btrfs [subvolume] suffix, so bind mounts and subvolumes match.
mount_device() {
  local source
  source="$(findmnt --noheadings --output SOURCE --target "$1" 2>/dev/null)" || return 1
  echo "${source%%\[*}"
}

# A destination on kin's own disk, or an unmounted mountpoint on /, is not a backup.
DEST_MOUNT="$(mount_target "$DEST")" || die "can't find the filesystem holding $DEST."
DEST_DEVICE="$(mount_device "$DEST")" || die "can't find the device holding $DEST."
DATA_DEVICE="$(mount_device "$BASE")" || die "can't find the device holding $BASE."
if [ "$DEST_DEVICE" = "$DATA_DEVICE" ] || [ "$DEST_MOUNT" = / ]; then
  die "$DEST is on $DEST_DEVICE ($DEST_MOUNT), the same disk as kin's data or the root filesystem.
Mount the backup volume there first."
fi

# True when the filesystem holding $1 sits on a LUKS or dm-crypt device.
on_encrypted_volume() {
  local source
  source="$(findmnt --noheadings --output SOURCE --target "$1" 2>/dev/null)" || return 1
  source="${source%%\[*}"
  [ -b "$source" ] || return 1
  lsblk --noheadings --inverse --output TYPE "$source" 2>/dev/null | grep -qx crypt
}

if [ "$ASSUME_ENCRYPTED" -eq 0 ] && ! on_encrypted_volume "$DEST"; then
  die "$DEST is not on a LUKS/dm-crypt volume. The backup holds secrets in plain text.
Use an encrypted destination, or pass --i-know-dest-is-encrypted if it is encrypted another way."
fi

umask 077
DAY="$(date +%F)"
NAME="kin-$DAY"
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '.kin-*' -mmin +1440 -exec rm -rf {} +
STAGE="$(mktemp -d "$DEST/.$NAME.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# The database comes from .backup below. The rest is logs or files the server recreates;
# worktrees and caches live outside userdata (apps/server/src/config.ts).
# The server writes while this reads: tar exits 1 for a file that changed or vanished, which
# is accepted on the create side only. The extract side stays strict.
mkdir "$STAGE/$NAME" "$STAGE/$NAME/userdata"
{
  tar -C "$USERDATA" --anchored --warning=no-file-changed --warning=no-file-removed \
    --ignore-failed-read \
    --exclude=./statev2.sqlite --exclude=./statev2.sqlite-wal --exclude=./statev2.sqlite-shm \
    --exclude=./statev2.sqlite-journal --exclude=./logs --exclude=./worktrees \
    --exclude=./browser-artifacts --exclude=./server-runtime.json \
    --exclude=./speech --exclude=./server-browser --exclude=./triage --exclude=./antigravity-tmp \
    --exclude='./server-owner.sqlite*' --exclude='./usage-scan-cache*' \
    -cf - . || [ $? -eq 1 ]
} | tar -C "$STAGE/$NAME/userdata" -xpf -

# .backup takes a consistent snapshot of a live WAL database.
sqlite3 "$DB" ".backup '$STAGE/$NAME/userdata/statev2.sqlite'"
[ "$(sqlite3 "$STAGE/$NAME/userdata/statev2.sqlite" 'PRAGMA quick_check;')" = ok ] ||
  die "backup failed its integrity check."
if [ -f "$BASE/service.env" ]; then
  cp -p "$BASE/service.env" "$STAGE/$NAME/service.env"
fi

chmod -R go-rwx "$STAGE"
rm -rf "${DEST:?}/$NAME"
mv "$STAGE/$NAME" "$DEST/$NAME"

# Prune by the date in the name; copied files keep their source mtimes.
CUTOFF="$(date -d "-$((KEEP_DAYS - 1)) days" +%F)"
for item in "$DEST"/kin-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*; do
  [ -e "$item" ] || continue
  name="$(basename "$item")"
  day="${name:4:10}"
  if [[ "$day" < "$CUTOFF" ]]; then rm -rf "$item"; fi
done

echo "Backed up $USERDATA to $DEST/$NAME"
