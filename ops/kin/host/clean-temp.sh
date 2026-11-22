#!/usr/bin/env bash
# Gives back temporary space on the Kin host. kin-temp-clean.timer runs it hourly as the kin user:
#
#   systemctl --user start kin-temp-clean    # by hand; journalctl --user -u kin-temp-clean shows what it did
#
# Kin's server runs it with --now when a person taps Free up space now or a turn fails for want of
# space (then also --space-failed): a last line `kin-clean removed=N freed_kb=N failed=N` follows.
# --tmpdir-only (a dev server's stand-in) leaves /tmp alone. One clean runs at a time: the timer's
# and the server's take the same lock (LOCK).
#
# Removes the user's own top-level entries in each folder of ROOTS that nothing has modified inside
# for MAX_AGE_MINUTES (LOW_SPACE_AGE_MINUTES while a folder's disk, or the user's quota on it, has
# less than LOW_SPACE_PERCENT left, or after a turn failed for space; an entry holding a git checkout
# up to two levels down always gets the full MAX_AGE_MINUTES) and that no process of the user is in,
# holds open or listens on, looked at again right before it goes.
# Never touches another user's files, never follows a symlink, never leaves ROOTS.
#
# Sourcing this file defines its functions and runs nothing (scripts/kin-clean-temp.test.ts).

# Kin's temp folder (TMPDIR, set in ~/.config/kin/kin-server.env) and the system one agents also use.
ROOTS=(/tmp "${TMPDIR:-$HOME/.cache/kin-tmp}")
MAX_AGE_MINUTES=1440
LOW_SPACE_AGE_MINUTES=120
LOW_SPACE_PERCENT=20
# Seconds since the epoch the ages count back from; empty means the clock.
NOW=""
LOCK="${KIN_CLEAN_LOCK:-$HOME/.cache/kin-clean.lock}"
# Kin's own builds and the database copies update.sh keeps (update.sh names them). With --now the
# old ones go too: all but the running build and the one before it, and all but the newest
# KEEP_UPDATE_BACKUPS backups.
BUILDS="$HOME/kin-builds"
CURRENT="$HOME/kin-current"
UPDATE_BACKUPS="${KIN_UPDATE_BACKUPS:-$HOME/kin-update-backups}"
REPO="${KIN_REPO:-$HOME/t3code}"
KEEP_UPDATE_BACKUPS=3

# Waits for any other clean to finish; held until this script exits. No flock (macOS): no lock.
take_lock() {
  command -v flock >/dev/null 2>&1 || return 0
  mkdir -p "$(dirname "$LOCK")" && exec 9>>"$LOCK" && flock 9
}

# Every path a process of this user has as its working directory or an open file, and every
# listening socket's path, one per line.
held_paths() {
  local proc link
  for proc in /proc/[0-9]*; do
    [ -O "$proc" ] || continue
    for link in "$proc/cwd" "$proc"/fd/*; do
      link="$(readlink "$link" 2>/dev/null)" || continue
      case "$link" in /*) printf '%s\n' "${link% (deleted)}" ;; esac
    done
  done
  # Sockets show in fd/ as socket:[inode]; their paths are here.
  if [ -r /proc/net/unix ]; then awk 'NR > 1 && $8 ~ /^\// { print $8 }' /proc/net/unix; fi
}

# in_use <entry> <held paths>: true when a held path is the entry or lies inside it.
in_use() {
  local held
  while IFS= read -r held; do
    case "$held" in "$1" | "$1"/*) return 0 ;; esac
  done <<<"$2"
  return 1
}

# Percent left on the filesystem holding $1, or on the user's quota there when that is lower.
percent_left() {
  local disk quota
  disk="$(df -Pk "$1" | awk 'NR == 2 && $2 > 0 { print int($4 * 100 / $2) }')"
  quota="$(quota_percent_left "$(df -Pk "$1" | awk 'NR == 2 { print $6 }')")" || quota=""
  if [ -n "$quota" ] && { [ -z "$disk" ] || [ "$quota" -lt "$disk" ]; }; then disk="$quota"; fi
  echo "${disk:-100}"
}

# The user's block quota left on mount $1 as a percent; fails when no quota is set or readable.
quota_percent_left() {
  command -v quota >/dev/null 2>&1 || return 1
  quota -w -u "$(id -un)" -f "$1" 2>/dev/null | awk '
    NR > 2 { used = $2 + 0; limit = ($4 + 0 > 0) ? $4 + 0 : $3 + 0
      if (limit > 0) { left = int((limit - used) * 100 / limit); print (left < 0 ? 0 : left); found = 1; exit } }
    END { exit !found }'
}

# <epoch> as a UTC time both GNU and BSD find read.
utc() {
  date -u -d "@$1" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -u -r "$1" '+%Y-%m-%d %H:%M:%S'
}

# holds_checkout <entry>: true when the entry is a git checkout or holds one up to two levels down.
holds_checkout() {
  [ -n "$(find "$1" -mindepth 1 -maxdepth 3 -name .git -print -quit 2>/dev/null)" ]
}

# recent <entry> <utc time>: true when the entry or anything under it was modified after it.
recent() {
  [ -n "$(TZ=UTC find "$1" -xdev -newermt "$2" -print -quit 2>/dev/null)" ]
}

# Removes Kin's old builds and update backups; adds to removed_builds, removed_backups and freed.
# A build that isn't complete (an update may be writing it), the running one, the newest other
# complete one, and anything a process is in, stay.
free_kin_files() {
  local running="" previous="" dir kb name
  if [ -d "$BUILDS" ] && [ ! -L "$BUILDS" ]; then
    running="$(cd -P "$CURRENT" 2>/dev/null && pwd)" || running=""
    while IFS= read -r dir; do
      dir="${dir%/}"
      [ -L "$dir" ] || [ ! -f "$dir/apps/server/dist/bin.mjs" ] && continue
      [ "$(cd -P "$dir" && pwd)" = "$running" ] && continue
      if [ -z "$previous" ] && [ ! -e "$dir/.failed" ]; then previous="$dir"; continue; fi
      in_use "$(cd -P "$dir" && pwd)" "$(held_paths)" && continue
      kb="$(du -sk "$dir" 2>/dev/null | awk '{ print $1 }')"
      rm -rf "$dir" 2>/dev/null
      if [ ! -e "$dir" ]; then
        removed_builds=$((removed_builds + 1))
        freed=$((freed + ${kb:-0}))
      fi
    done < <(ls -1dt "$BUILDS"/*/ 2>/dev/null)
    if [ "$removed_builds" -gt 0 ] && [ -d "$REPO/.git" ]; then git -C "$REPO" worktree prune 2>/dev/null; fi
  fi
  if [ -d "$UPDATE_BACKUPS" ] && [ ! -L "$UPDATE_BACKUPS" ]; then
    while IFS= read -r name; do
      kb="$(du -sk "$UPDATE_BACKUPS/$name" 2>/dev/null | awk '{ print $1 }')"
      if rm -f "$UPDATE_BACKUPS/$name" 2>/dev/null; then
        removed_backups=$((removed_backups + 1))
        freed=$((freed + ${kb:-0}))
      fi
    done < <(ls -1 "$UPDATE_BACKUPS" | { grep -E '^statev2-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+\.sqlite$' || true; } |
      sort -r | tail -n +$((KEEP_UPDATE_BACKUPS + 1)))
  fi
}

human() {
  awk -v k="$1" 'BEGIN { split("KB MB GB TB", u); n = k; i = 1
    while (n >= 1024 && i < 4) { n /= 1024; i++ }
    printf (n < 10 && i > 1 ? "%.1f %s" : "%d %s"), n, u[i] }'
}

main() {
  set -uo pipefail
  local now root age cutoff day_cutoff limit entry held kb removed=0 freed=0 failed=0 low="" asked=""
  local space_failed="" removed_builds=0 removed_backups=0 kept_freed
  local arg
  for arg in "$@"; do
    case "$arg" in
      --now) asked=1 ;;
      --space-failed) space_failed=1 ;;
      --tmpdir-only)
        ROOTS=("${TMPDIR:-$HOME/.cache/kin-tmp}")
        # A dev server's stand-in for Kin's own files sits beside its temp folder.
        BUILDS="$(dirname "${ROOTS[0]}")/kin-dev-host/kin-builds"
        CURRENT="$(dirname "${ROOTS[0]}")/kin-dev-host/kin-current"
        UPDATE_BACKUPS="$(dirname "${ROOTS[0]}")/kin-dev-host/kin-update-backups"
        REPO="$(dirname "${ROOTS[0]}")/kin-dev-host/no-repo"
        ;;
      *) echo "clean-temp.sh: unknown option $arg" >&2; return 2 ;;
    esac
  done
  take_lock || { echo "clean-temp.sh: couldn't take $LOCK" >&2; return 1; }
  now="${NOW:-$(date +%s)}"
  held="$(held_paths)"
  for root in "${ROOTS[@]}"; do
    [ -d "$root" ] && [ ! -L "$root" ] || continue
    # /proc names held paths physically, so entries must be named the same way.
    root="$(cd -P "$root" && pwd)" || continue
    age="$MAX_AGE_MINUTES"
    if [ -n "$space_failed" ] || [ "$(percent_left "$root")" -lt "$LOW_SPACE_PERCENT" ]; then
      age="$LOW_SPACE_AGE_MINUTES"
      low=1
    fi
    cutoff="$(utc $((now - age * 60)))"
    day_cutoff="$(utc $((now - MAX_AGE_MINUTES * 60)))"
    while IFS= read -r -d '' entry; do
      limit="$cutoff"
      # An agent's checkout may be waiting on a person's answer with work not yet pushed.
      if holds_checkout "$entry"; then limit="$day_cutoff"; fi
      if in_use "$entry" "$held" || recent "$entry" "$limit"; then continue; fi
      # The scan took time: a process may have started using it since.
      if in_use "$entry" "$(held_paths)"; then continue; fi
      kb="$(du -sk "$entry" 2>/dev/null | awk '{ print $1 }')"
      # A read-only folder (a package cache) can't be emptied until it is writable again.
      if ! rm -rf "$entry" 2>/dev/null && [ -d "$entry" ] && [ ! -L "$entry" ]; then
        chmod -R u+w "$entry" 2>/dev/null
        rm -rf "$entry" 2>/dev/null
      fi
      if [ -e "$entry" ] || [ -L "$entry" ]; then
        failed=$((failed + 1))
      else
        removed=$((removed + 1))
        freed=$((freed + ${kb:-0}))
      fi
    done < <(find "$root/" -mindepth 1 -maxdepth 1 -user "$(id -u)" -print0 2>/dev/null)
  done
  kept_freed="$freed"
  if [ -n "$asked" ]; then free_kin_files; fi
  if [ "$removed" -eq 0 ]; then
    printf 'Nothing old to clear from the temporary folders.'
  else
    printf 'Cleared %d old temporary item(s) and gave back %s.' "$removed" "$(human "$kept_freed")"
  fi
  if [ -n "$low" ]; then printf ' Space was low, so anything untouched for %d hours counted as old.' $((LOW_SPACE_AGE_MINUTES / 60)); fi
  if [ $((removed_builds + removed_backups)) -gt 0 ]; then
    printf ' Removed %d old version(s) of Kin and %d old backup(s).' "$removed_builds" "$removed_backups"
  fi
  if [ "$failed" -gt 0 ]; then printf " %d item(s) couldn't be removed." "$failed"; fi
  printf '\n'
  if [ -n "$asked" ]; then
    printf 'kin-clean removed=%d freed_kb=%d failed=%d builds=%d backups=%d\n' \
      "$removed" "$freed" "$failed" "$removed_builds" "$removed_backups"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
