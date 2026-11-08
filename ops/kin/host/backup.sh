#!/usr/bin/env bash
# Backs up the Kin server's state to an encrypted volume and keeps 14 days.
# Run as the kin user (kin-backup.timer does this nightly). Reads the kin user's
# ~/.t3, resolved from the password database, never the invoking user's.
#
#   backup.sh --dest /mnt/backup/kin [--user kin] [--i-know-dest-is-encrypted]
#
# Writes kin-YYYY-MM-DD.sqlite, kin-YYYY-MM-DD-secrets/ and kin-YYYY-MM-DD-service.env.
set -euo pipefail

KIN_USER=kin
DEST=""
ASSUME_ENCRYPTED=0
KEEP_DAYS=14

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
DB="$BASE/userdata/statev2.sqlite"
[ -f "$DB" ] || die "no database at $DB."
[ -d "$DEST" ] || die "destination $DEST does not exist."

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
STAGE="$(mktemp -d "$DEST/.kin-$DAY.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# .backup takes a consistent snapshot of a live WAL database.
sqlite3 "$DB" ".backup '$STAGE/kin-$DAY.sqlite'"
[ "$(sqlite3 "$STAGE/kin-$DAY.sqlite" 'PRAGMA quick_check;')" = ok ] || die "backup failed its integrity check."
if [ -d "$BASE/userdata/secrets" ]; then
  cp -a "$BASE/userdata/secrets" "$STAGE/kin-$DAY-secrets"
fi
if [ -f "$BASE/service.env" ]; then
  cp -p "$BASE/service.env" "$STAGE/kin-$DAY-service.env"
fi

chmod -R go-rwx "$STAGE"
for item in "$STAGE"/kin-"$DAY"*; do
  name="$(basename "$item")"
  rm -rf "${DEST:?}/$name"
  mv "$item" "$DEST/$name"
done

# Prune by the date in the name; copied files keep their source mtimes.
CUTOFF="$(date -d "-$((KEEP_DAYS - 1)) days" +%F)"
for item in "$DEST"/kin-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*; do
  [ -e "$item" ] || continue
  name="$(basename "$item")"
  day="${name:4:10}"
  if [[ "$day" < "$CUTOFF" ]]; then rm -rf "$item"; fi
done

echo "Backed up $DB to $DEST/kin-$DAY.sqlite"
