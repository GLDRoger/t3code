#!/usr/bin/env bash
# With the owner's GitHub connected, Chief of staff clones an invented repo in the owner's chat and
# hands the change to a T3 delegated task in its own worktree; T3's finish notice becomes exactly
# one reply in the owner's chat. The same request in Zoya's chat is refused and offered to the owner.
source "$(dirname "$0")/lib.sh"
VERIFY="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify"
FAKE="$VERIFY/github"
WORK="$VERIFY/scratch-$RUN"
mkdir -p "$WORK" "$VERIFY/turns"
trap 'kv as owner rpc kin.github.disconnect "{}" >/dev/null 2>&1 || true' EXIT

# An invented repository as GitHub would hold it: a bare origin with one commit on main.
ORIGIN="$WORK/origin/ambermill-site.git"
git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$WORK/seed" 2>/dev/null
(cd "$WORK/seed" && printf 'theme: light\n' >settings.txt && git add . &&
  git -c user.name=Seed -c user.email=seed@example.invalid commit -qm init && git push -q origin main)

STATUS="$(kv as owner rpc kin.github.connect.start "{\"token\":\"ghp_good_invented_$RUN\"}")"
expect_in "$STATUS" "invented-owner" "GitHub did not connect as the owner: $STATUS"

PR="https://github.com/invented-owner/ambermill-site/pull/$(($(cat "$FAKE/state/prs" 2>/dev/null || echo 0) + 1))"
CHILD="child-$RUN"
# The delegated task, after a while as real work takes: a plain commit, pushed, and a PR. With no
# GitHub App set up the owner is the author.
node -e '
const [file, fake, pr] = process.argv.slice(1);
require("node:fs").writeFileSync(file, JSON.stringify({
  calls: [{ name: "sleep", arguments: { ms: 10000 } }, { name: "shell", arguments: { command: [
    "git checkout -qb dark-theme",
    "printf \"theme: dark\\n\" > settings.txt",
    "git -c user.name=invented-owner -c user.email=1+invented-owner@users.noreply.github.com commit -qam \"feat: dark theme setting\"",
    "git push -q origin dark-theme",
    `PATH="${fake}:$PATH" KIN_FAKE_GH="${fake}/state" gh pr create --fill`,
  ].join(" && ") } }],
  reply: `Added the dark theme setting. ${pr}`,
}));' "$VERIFY/turns/$CHILD.json" "$FAKE" "$PR"
# T3's notice that it finished: read the task, then the one reply.
node -e '
const [file, pr] = process.argv.slice(1);
require("node:fs").writeFileSync(file, JSON.stringify({
  calls: [{ name: "sleep", arguments: { ms: 3000 } }, { name: "task_status", arguments: { taskId: "$task" } }],
  reply: `The dark theme is in ambermill-site: ${pr}`,
}));' "$VERIFY/turns/notice.json" "$PR"
node -e '
const [file, origin, clone, child] = process.argv.slice(1);
require("node:fs").writeFileSync(file, JSON.stringify({
  calls: [
    { name: "orchestrator_capabilities" },
    { name: "t3_project_clone", arguments: { remoteUrl: origin, destinationPath: clone } },
    { name: "t3_project_create", arguments: { title: "ambermill-site", workspaceRoot: "$from:1:cwd" } },
    { name: "delegate_task", arguments: {
      task: `[kv:${child}] Add a dark theme setting to ambermill-site and open a PR.`,
      title: "Dark theme", isolation: "worktree", target: { projectId: "$from:2:id" } } },
  ],
  reply: "A task is adding the dark theme; you will hear when its PR is up.",
}));' "$WORK/owner.json" "$ORIGIN" "$WORK/clones/ambermill-site" "$CHILD"

OUT="$(kv tool chief --script "$WORK/owner.json")"
expect_in "$OUT" "t3_project_clone: ok" "the owner's turn couldn't clone: $OUT"
expect_in "$OUT" "delegate_task: ok" "the owner's turn couldn't start a delegated task: $OUT"

replies() { kv db "select count(*) from kin_messages where author_kind = 'agent' and body like '%$PR%'" | tail -1; }
for _ in $(seq 1 90); do [[ "$(replies)" -ge 1 ]] && break; sleep 1; done
[[ "$(replies)" -ge 1 ]] || fail "no reply with $PR reached a chat after the task finished"
sleep 8 # a second reply would come from the same notice within seconds
[[ "$(replies)" -eq 1 ]] || fail "the finished task got $(replies) replies, not one"
kv as owner web open chat:chief >/dev/null
kv as owner web wait "$PR" >/dev/null || fail "the reply isn't in the owner's chat"
expect_not_in "$(kv as zoya web open chat:chief >/dev/null; kv as zoya web snapshot)" "$PR" \
  "the owner's reply showed in Zoya's chat"
STATUS_LINE="$(kv db "select json from kin_events where tag = 'task.finished' order by received_at desc limit 1" | tail -1)"
expect_in "$STATUS_LINE" "\"chatId\"" "no task.finished event was recorded"
expect_in "$(cat "$VERIFY/turns/notice.result.json")" "$PR" "task_status didn't return the task's PR"

# The task ran in its own worktree: the clone stays on main, and the PR's branch is on the origin.
[[ "$(git -C "$WORK/clones/ambermill-site" branch --show-current)" == main ]] ||
  fail "the delegated task changed the clone instead of its own worktree"
AUTHOR="$(git --git-dir "$ORIGIN" log -1 --format='%an <%ae>' dark-theme)"
expect_in "$AUTHOR" "invented-owner <1+invented-owner@users.noreply.github.com>" \
  "the commit isn't the owner's: $AUTHOR"

# The same request in a member's chat: T3's tools aren't there, and the agent offers it to the owner.
node -e '
const [file, origin, clone] = process.argv.slice(1);
require("node:fs").writeFileSync(file, JSON.stringify({
  calls: [
    { name: "t3_project_clone", arguments: { remoteUrl: origin, destinationPath: clone } },
    { name: "delegate_task", arguments: { task: "Add a dark theme setting to ambermill-site.", isolation: "worktree" } },
    { name: "kin_relay", arguments: { to: "Rhea Kapoor", text: "Zoya asked for a dark theme in ambermill-site. Shall I start it?" } },
  ],
  reply: "I can’t start code work from this chat, so I’ve asked Rhea.",
}));' "$WORK/member.json" "$ORIGIN" "$WORK/clones/member-attempt"
OUT="$(kv tool chief --script "$WORK/member.json" --as-turn-of zoya)"
expect_in "$OUT" "t3_project_clone: refused" "a member's turn could clone: $OUT"
expect_in "$OUT" "delegate_task: refused" "a member's turn could start a delegated task: $OUT"
expect_in "$OUT" "kin_relay: ok" "the member's request didn't reach the owner: $OUT"
[[ ! -e "$WORK/clones/member-attempt" ]] || fail "a member's turn cloned the repo"
pass "one reply with $PR in the owner's chat after a delegated task in its own worktree; Zoya's request was refused and offered to the owner"
