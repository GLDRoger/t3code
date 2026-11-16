#!/usr/bin/env bash
# Members (Zoya, with Clients on, and Arjun) see no currency amount or money document on any screen they can open.
source "$(dirname "$0")/lib.sh"
MONEY='₹|INR|Rs\.? ?[0-9]|\$ ?[0-9]|[0-9]{1,3}(,[0-9]{2,3})+|INV/|INV-[0-9]|QT-[0-9]'
ROUTES=(tasks clients "clients?client=C-1" "clients?client=C-2" "clients?client=C-3"
  "clients?project=P-1" "clients?project=P-2" "clients?project=P-3" docs "docs?doc=D-7" money chat:chief)
for person in zoya arjun; do
  for route in "${ROUTES[@]}"; do
    kv as "$person" web open "$route" >/dev/null
    hits="$(kv as "$person" web snapshot --full | grep -oE "$MONEY" | sort -u | tr '\n' ' ' || true)"
    [[ -z "$hits" ]] || fail "$person on $route sees: $hits"
  done
done
pass "${#ROUTES[@]} screens each for Zoya and Arjun show no amount or money document"
