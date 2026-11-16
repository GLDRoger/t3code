#!/usr/bin/env bash
# The owner gives a new task to Zoya in the web New task sheet; Zoya sees it in Tasks and is told in her chat.
source "$(dirname "$0")/lib.sh"
TITLE="Proof $RUN: check the clinic logo files"
kv as owner web open tasks >/dev/null
kv as owner web click --name "New task" >/dev/null
kv as owner web type --name "What needs doing" "$TITLE" >/dev/null
kv as owner web click --name "Give it to" >/dev/null
kv as owner web click --name "Zoya Sheikh" --role option >/dev/null
kv as owner web click --name "Add task" >/dev/null
kv as zoya web open tasks >/dev/null
kv as zoya web wait "$TITLE" >/dev/null || fail "Zoya's Tasks never showed the task"
kv as zoya web open chat:chief >/dev/null
kv as zoya web wait "gave you" >/dev/null || fail "Zoya's chat has no 'gave you' line"
expect_in "$(kv as zoya web snapshot)" "$TITLE" "Zoya's chat doesn't name the task"
expect_not_in "$(kv as arjun web open tasks >/dev/null; kv as arjun web snapshot)" "$TITLE" "Arjun sees Zoya's new task"
pass "Zoya sees the task in Tasks and in her chat; Arjun doesn't"
