#!/usr/bin/env bash
# Dev, P-1's lead, marks W-4 "Only me" and takes it off again from his own sheet; while marked, Zoya doesn't see it and the owner reads who it is kept to.
source "$(dirname "$0")/lib.sh"
TITLE="Set up the appointments API"
kv as dev web open "tasks?task=W-4" >/dev/null
kv as dev web wait "Who can see this" >/dev/null
kv as dev web click --name "Who can see this: Rhea Kapoor, co-owners, whoever has it or gave it, and the people on Lumen Grove patient booking app. Change" >/dev/null
kv as dev web click --name "Only me" --role menuitemradio >/dev/null
kv as dev web wait "Only you, co-owners and whoever has it" >/dev/null || fail "Dev's sheet never said 'Only you'"
kv as zoya web open tasks >/dev/null
expect_not_in "$(kv as zoya web snapshot --full)" "$TITLE" "Zoya sees W-4 while it is Dev's only"
kv as owner web open "tasks?task=W-4" >/dev/null
kv as owner web wait "Only Dev Malhotra, co-owners and whoever has it" >/dev/null || fail "the owner isn't told who W-4 is kept to"
kv as dev web click --name "Who can see this: Only you, co-owners and whoever has it. Change" >/dev/null ||
  fail "Dev has no way to change it back"
kv as dev web click --name "People on it and the project" --role menuitemradio >/dev/null
kv as dev web wait "the people on Lumen Grove patient booking app" >/dev/null || fail "Dev couldn't undo his Only me"
kv as zoya web open tasks >/dev/null
kv as zoya web wait "$TITLE" >/dev/null || fail "W-4 didn't come back to Zoya"
pass "Dev marks W-4 Only me and undoes it himself; Zoya loses it and gets it back; the owner reads it is Dev's"
