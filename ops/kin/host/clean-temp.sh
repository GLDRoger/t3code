#!/usr/bin/env bash
# Gives back temporary space on the Kin host. kin-temp-clean.timer runs it hourly as the kin user:
#
#   systemctl --user start kin-temp-clean    # by hand; journalctl --user -u kin-temp-clean shows what it did
#
# Removes the user's own top-level entries in each folder of ROOTS that nothing has modified inside
# for MAX_AGE_MINUTES (LOW_SPACE_AGE_MINUTES while a folder's disk, or the user's quota on it, has
# less than LOW_SPACE_PERCENT left) and that no process of the user is in, holds open or listens on.
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

# recent <entry> <utc time>: true when the entry or anything under it was modified after it.
recent() {
  [ -n "$(TZ=UTC find "$1" -xdev -newermt "$2" -print -quit 2>/dev/null)" ]
}

human() {
  awk -v k="$1" 'BEGIN { split("KB MB GB TB", u); n = k; i = 1
    while (n >= 1024 && i < 4) { n /= 1024; i++ }
    printf (n < 10 && i > 1 ? "%.1f %s" : "%d %s"), n, u[i] }'
}

main() {
  set -uo pipefail
  local now root age cutoff entry held kb removed=0 freed=0 failed=0 low=""
  now="${NOW:-$(date +%s)}"
  held="$(held_paths)"
  for root in "${ROOTS[@]}"; do
    [ -d "$root" ] && [ ! -L "$root" ] || continue
    # /proc names held paths physically, so entries must be named the same way.
    root="$(cd -P "$root" && pwd)" || continue
    age="$MAX_AGE_MINUTES"
    if [ "$(percent_left "$root")" -lt "$LOW_SPACE_PERCENT" ]; then
      age="$LOW_SPACE_AGE_MINUTES"
      low=1
    fi
    cutoff="$(utc $((now - age * 60)))"
    while IFS= read -r -d '' entry; do
      if recent "$entry" "$cutoff" || in_use "$entry" "$held"; then continue; fi
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
  if [ "$removed" -eq 0 ]; then
    printf 'Nothing old to clear from the temporary folders.'
  else
    printf 'Cleared %d old temporary item(s) and gave back %s.' "$removed" "$(human "$freed")"
  fi
  if [ -n "$low" ]; then printf ' Space was low, so anything untouched for %d hours counted as old.' $((LOW_SPACE_AGE_MINUTES / 60)); fi
  if [ "$failed" -gt 0 ]; then printf " %d item(s) couldn't be removed." "$failed"; fi
  printf '\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
