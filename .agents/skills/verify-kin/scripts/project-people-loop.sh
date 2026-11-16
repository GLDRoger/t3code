#!/usr/bin/env bash
# The owner puts Zoya on P-2 from its page: she is told once, with a way to it, and sees its tasks; taken off, they leave her open Tasks at once. Arjun, not on it, never sees them; Zoya can't put herself on a project.
source "$(dirname "$0")/lib.sh"
TITLE="Visit plan $RUN"
ZOYA="$(kv people | awk -F'\t' '$1=="zoya"{print $3}')"
kv as owner rpc kin.work.create "{\"clientRequestId\":\"$SCRIPT-$RUN\",\"title\":\"$TITLE\",\"project\":\"P-2\"}" >/dev/null
# She is refused putting herself on it, and doesn't see it before.
refused="$(kv as zoya rpc kin.work.projectPeople "{\"key\":\"P-2\",\"add\":[{\"_tag\":\"person\",\"personId\":\"$ZOYA\"}]}" 2>&1 || true)"
expect_in "$refused" "KinChatError" "Zoya put herself on P-2"
kv as zoya web open tasks >/dev/null
expect_not_in "$(kv as zoya web snapshot --full)" "$TITLE" "Zoya sees P-2's task before she is on it"
# The owner adds her from the project's People section.
kv as owner web open "tasks?project=P-2" >/dev/null
kv as owner web click --name "Add people" >/dev/null
kv as owner web click --name "Zoya Sheikh" --role checkbox >/dev/null
kv as owner web click --name "Add" >/dev/null
kv as owner web wait "Who's on this project" --gone >/dev/null || fail "the Add people sheet never closed"
expect_in "$(kv as owner web snapshot)" "Take Zoya Sheikh off" "P-2's People never listed Zoya"
kv as zoya web open tasks >/dev/null
kv as zoya web wait "$TITLE" >/dev/null || fail "Zoya's Tasks never showed P-2's task"
kv as zoya web open chat:chief >/dev/null
kv as zoya web wait "Rhea Kapoor added you to P-2" >/dev/null || fail "Zoya wasn't told she was added"
expect_in "$(kv as zoya web snapshot)" "Open project" "the notice has no way to the project"
kv as arjun web open tasks >/dev/null
expect_not_in "$(kv as arjun web snapshot --full)" "$TITLE" "Arjun sees P-2's task"
# Taken off, it leaves her open Tasks without a reload.
kv as zoya web open tasks >/dev/null
kv as zoya web wait "$TITLE" >/dev/null
kv as owner web open "tasks?project=P-2" >/dev/null
kv as owner web click --name "Take Zoya Sheikh off" >/dev/null
kv as zoya web wait "$TITLE" --gone >/dev/null || fail "P-2's task stayed in Zoya's Tasks after she was taken off"
pass "Zoya added to P-2 from its page is told and sees its tasks; taken off, they leave at once; Arjun never sees them"
