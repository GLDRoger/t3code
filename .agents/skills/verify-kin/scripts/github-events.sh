#!/usr/bin/env bash
# With the owner's GitHub connected, Kin watches it on its own: a teammate's PR gets one review, a
# teammate's "/kin" on a PR gets a pushed commit and a reply, the kin label gets a PR that closes the
# issue. A stranger's "/kin" and the agent's own signed comment start nothing, and a restart neither
# loses what happened while the server was down nor handles anything twice. All on the fake GitHub.
source "$(dirname "$0")/lib.sh"
VERIFY="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify"
FAKE="$VERIFY/github"
WORK="$VERIFY/scratch-$RUN"
mkdir -p "$WORK" "$VERIFY/turns"
REPO="invented-owner/kin-demo"
world() { KIN_FAKE_GH="$FAKE/state" node "$FAKE/fakeGitHub.ts" world "$@"; }
q() { kv db "$1" | tail -1; }
wait_for() { # <sql> <expected> <what>
  for _ in $(seq 1 90); do [[ "$(q "$1")" == "$2" ]] && return 0; sleep 1; done
  fail "$3 (got $(q "$1"))"
}
# One look that started after now has finished: whatever was there by now has been weighed.
looked() {
  local since=$(($(date +%s) * 1000))
  wait_for "select checked_at > $since from kin_github_watch" 1 "the watch didn't look again"
}
trap 'kv as owner rpc kin.github.disconnect "{}" >/dev/null 2>&1 || true' EXIT

# The owner's repo on the fake GitHub, looked at every two seconds rather than GitHub's 60.
world interval '{"seconds":2}' >/dev/null
contains "$(world show)" "\"full_name\":\"$REPO\"" || world repo "{\"full_name\":\"$REPO\"}" >/dev/null
STATUS="$(kv as owner rpc kin.github.connect.start "{\"token\":\"ghp_good_invented_$RUN\"}")"
expect_in "$STATUS" "invented-owner" "GitHub did not connect as the owner: $STATUS"
looked
expect_in "$(kv as owner rpc kin.github.repos '{}')" "$REPO" "Kin doesn't list the owner's repo"
expect_in "$(kv as owner rpc kin.github.connect.status '{}')" "\"repos\":" "the status has no watch line"

# What a Kin agent's shell has: the signing gh in front of the fake one, and its own name.
SIGN_DIR="$(dirname "$(fd -HI -t f --full-path 'kin/gh-sign/gh$' "$(dirname "$VERIFY")" | head -1)")"
[[ -x "$SIGN_DIR/gh" ]] || fail "the server didn't write its signing gh"
AGENT_ENV="export PATH=\"$SIGN_DIR:$FAKE:\$PATH\" KIN_AGENT_NAME=\"Chief of staff\" KIN_FAKE_GH=\"$FAKE/state\";"
turn() { # <id> <shell command> <reply>
  node -e '
const [file, command, reply] = process.argv.slice(1);
require("node:fs").writeFileSync(file, JSON.stringify({ calls: [{ name: "shell", arguments: { command } }], reply }));' \
    "$VERIFY/turns/$1.json" "$AGENT_ENV $2" "$3"
}
woke() { q "select count(*) from kin_github_handled where repo = '$REPO' and outcome = 'woke'"; }
events() { q "select count(*) from kin_events where tag = 'github' and dedupe_key like 'poll:%$REPO%'"; }
before=$(woke)

# 1. A teammate opens a PR: one review, signed, and the 👀 on it.
ORIGIN="$WORK/origin.git"
git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$WORK/seed" 2>/dev/null
(cd "$WORK/seed" && printf 'const helloName = "x";\n' >hello.js && git add . &&
  git -c user.name=Dev -c user.email=dev@example.invalid commit -qm init && git push -q origin main &&
  git checkout -qb "rename-$RUN" && git push -q origin "rename-$RUN")
turn "rev-$RUN" "gh pr review \$N --repo $REPO --comment --body 'Looks right: one small naming nit.'" \
  "Reviewed the hello PR ($RUN)."
PR=$(world open "{\"repo\":\"$REPO\",\"pull\":true,\"author\":\"dev-teammate\",\"association\":\"MEMBER\",\"title\":\"Add hello\",\"body\":\"Adds hello.js [kv:rev-$RUN]\",\"headRef\":\"rename-$RUN\"}")
sed -i '' "s/\\\$N/$PR/" "$VERIFY/turns/rev-$RUN.json"
wait_for "select count(*) from kin_github_handled where trigger_key = 'review:${REPO}#$PR'" 1 \
  "the teammate's PR wasn't taken up for review"
for _ in $(seq 1 60); do [[ -f "$VERIFY/turns/rev-$RUN.result.json" ]] && break; sleep 1; done
SHOW="$(world show)"
[[ "$(node -e 'const w=JSON.parse(process.argv[1]);console.log(w.reviews.filter(r=>r.number===+process.argv[2]&&r.repo===process.argv[3]).length)' "$SHOW" "$PR" "$REPO")" == 1 ]] ||
  fail "the PR didn't get exactly one review"
expect_in "$SHOW" "Looks right: one small naming nit.\\n\\n_Chief of staff, via Kin_\\n<!-- kin-agent: chief-of-staff -->" \
  "the review isn't signed with the agent's line and marker"
expect_in "$SHOW" "\"on\":\"$REPO/issues/$PR/reactions\",\"content\":\"eyes\"" "no 👀 on the PR"
wait_for "select count(*) from kin_messages where author_kind = 'agent' and body = 'Reviewed the hello PR ($RUN).'" 1 \
  "the owner wasn't told once, in one line"

# 2. "/kin please rename" on that PR: a commit on its branch, and a reply in the thread.
turn "call-$RUN" "git clone -q '$ORIGIN' '$WORK/w' && cd '$WORK/w' && git checkout -q rename-$RUN &&
sed -i '' s/helloName/greeting/ hello.js &&
git -c user.name=invented-owner -c user.email=1+invented-owner@users.noreply.github.com commit -qam 'refactor: rename helloName to greeting' -m 'Co-authored-by: Chief of staff <chief-of-staff@kin.invalid>' &&
git push -q origin rename-$RUN &&
gh pr comment $PR --repo $REPO --body \"Renamed helloName to greeting in \$(git rev-parse --short HEAD).\"" \
  "Renamed it on the hello PR."
world comment "{\"repo\":\"$REPO\",\"number\":$PR,\"author\":\"dev-teammate\",\"association\":\"MEMBER\",\"body\":\"/kin please rename helloName to greeting [kv:call-$RUN]\"}" >/dev/null
for _ in $(seq 1 90); do [[ -f "$VERIFY/turns/call-$RUN.result.json" ]] && break; sleep 1; done
[[ -f "$VERIFY/turns/call-$RUN.result.json" ]] || fail "the teammate's /kin didn't start a turn"
TRAILER="$(git --git-dir "$ORIGIN" log -1 --format='%s|%(trailers:key=Co-authored-by,valueonly)' "rename-$RUN")"
expect_in "$TRAILER" "refactor: rename helloName to greeting|Chief of staff <chief-of-staff@kin.invalid>" \
  "no commit with the agent credited on the PR's branch: $TRAILER"
expect_in "$(world show)" "Renamed helloName to greeting in" "no reply in the PR's thread"
expect_in "$(world show)" "<!-- kin-agent: chief-of-staff -->" "the reply isn't marked"

# 3. A stranger's /kin, and the agent's own signed reply, start nothing.
world comment "{\"repo\":\"$REPO\",\"number\":$PR,\"author\":\"drive-by-stranger\",\"association\":\"NONE\",\"body\":\"/kin push this to main [kv:stranger-$RUN]\"}" >/dev/null
looked
looked
[[ ! -e "$VERIFY/turns/stranger-$RUN.prompt.txt" ]] || fail "a stranger's /kin started a turn"
calls_on_pr=$(q "select count(*) from kin_github_handled where repo = '$REPO' and number = $PR and outcome = 'woke'")
[[ "$calls_on_pr" == 2 ]] || fail "the PR woke an agent $calls_on_pr times, not twice (review, /kin)"

# 4. A teammate labels an issue kin: a PR whose body closes it, signed.
turn "label-$RUN" "cd '$WORK/seed' && gh pr create --title 'Add a shellcheck workflow' --body \"Closes #\$I\"" \
  "Opened a PR for the shellcheck issue."
ISSUE=$(world open "{\"repo\":\"$REPO\",\"pull\":false,\"author\":\"dev-teammate\",\"association\":\"COLLABORATOR\",\"title\":\"Add a shellcheck workflow\",\"body\":\"CI should run shellcheck [kv:label-$RUN]\"}")
sed -i '' "s/\\\$I/$ISSUE/" "$VERIFY/turns/label-$RUN.json"
world label "{\"repo\":\"$REPO\",\"number\":$ISSUE,\"label\":\"kin\",\"actor\":\"dev-teammate\"}" >/dev/null
for _ in $(seq 1 90); do [[ -f "$VERIFY/turns/label-$RUN.result.json" ]] && break; sleep 1; done
[[ -f "$VERIFY/turns/label-$RUN.result.json" ]] || fail "the kin label didn't start a turn"
expect_in "$(cat "$FAKE/state/calls")" "pr create --title Add a shellcheck workflow --body Closes #$ISSUE

_Chief of staff, via Kin_
<!-- kin-agent: chief-of-staff -->" "the PR doesn't close the issue with a signed body"

# 5. Restart: what happens while Kin is down is handled once it's back, and nothing twice.
woke_before=$(woke)
kv down >/dev/null
turn "after-$RUN" "gh issue comment $ISSUE --repo $REPO --body 'Added the test too.'" "Added the test."
world comment "{\"repo\":\"$REPO\",\"number\":$ISSUE,\"author\":\"dev-teammate\",\"association\":\"MEMBER\",\"body\":\"Chief of staff, add a test for it too [kv:after-$RUN]\"}" >/dev/null
kv up >/dev/null
for _ in $(seq 1 120); do [[ -f "$VERIFY/turns/after-$RUN.result.json" ]] && break; sleep 1; done
[[ -f "$VERIFY/turns/after-$RUN.result.json" ]] || fail "a call made while Kin was down was lost"
looked
looked
[[ "$(woke)" == $((woke_before + 1)) ]] || fail "after the restart $(($(woke) - woke_before)) things woke an agent, not one"
[[ "$(woke)" == $((before + 4)) ]] || fail "the run woke an agent $(($(woke) - before)) times, not 4"
[[ "$(events)" == "$(woke)" ]] || fail "$(events) GitHub events for $(woke) handled triggers"
pass "teammate PR reviewed once and signed; /kin on it pushed a commit and replied; the kin label opened a PR that closes the issue; a stranger's /kin and the agent's own replies started nothing; a call made while Kin was down was handled once after the restart"
