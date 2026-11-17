#!/usr/bin/env bash
# Connections says which watched repos leave their default branch open to Kin's App. Protect all
# writes Kin's ruleset where GitHub allows it and names the repo it can't; Remove takes off only
# Kin's own; a member is refused; the owner's own rules stay his. All on the fake GitHub.
source "$(dirname "$0")/lib.sh"
VERIFY="$ROOT/.t3/kin-verify/${KIN_VERIFY_INSTANCE:-default}/verify"
FAKE="$VERIFY/github"
world() { KIN_FAKE_GH="$FAKE/state" node "$FAKE/fakeGitHub.ts" world "$@"; }
q() { kv db "$1" | tail -1; }
looked() {
  local since=$(($(date +%s) * 1000))
  for _ in $(seq 1 90); do [[ "$(q "select checked_at > $since from kin_github_watch")" == 1 ]] && return 0; sleep 1; done
  fail "the watch didn't look again"
}
# `<state> <byKin> <problem>` of one repo's default branch, as Connections reads it.
guard() {
  kv as owner rpc kin.github.repos '{}' | node -e '
const repo = process.argv[1];
const text = require("node:fs").readFileSync(0, "utf8");
const found = JSON.parse(text.slice(text.indexOf("{"))).repos.find((entry) => entry.repo === repo);
const g = found?.guard;
process.stdout.write(g === undefined ? "none" : `${g.state} ${g.byKin} ${g.problem ?? "-"}`);' "$1"
}
rulesets() { world show | node -e '
const repo = process.argv[1];
const world = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write((world.repos.find((entry) => entry.full_name === repo)?.rulesets ?? []).map((set) => set.name).join(","));' "$1"; }
trap 'kv as owner rpc kin.github.disconnect "{}" >/dev/null 2>&1 || true' EXIT

OPEN_ORG="invented-co/site-$RUN"
OPEN_OWN="invented-owner/notes-$RUN"
FREE="invented-owner/diary-$RUN"
OWN_RULES="invented-co/billing-$RUN"
world accounts '[{"login":"invented-co","id":7001,"type":"Organization","role":"admin"},{"login":"invented-owner","id":7000,"type":"User"}]' >/dev/null
world repo "{\"full_name\":\"$OPEN_ORG\"}" >/dev/null
world repo "{\"full_name\":\"$OPEN_OWN\"}" >/dev/null
world repo "{\"full_name\":\"$FREE\",\"planLimited\":true}" >/dev/null
world repo "{\"full_name\":\"$OWN_RULES\",\"rulesets\":[{\"id\":9$RANDOM,\"name\":\"Owner's reviews\",\"target\":\"branch\",\"enforcement\":\"active\",\"include\":[\"~DEFAULT_BRANCH\"],\"exclude\":[],\"rules\":[{\"type\":\"pull_request\",\"parameters\":{\"required_approving_review_count\":1}}],\"bypass\":[]}]}" >/dev/null
world interval '{"seconds":2}' >/dev/null
expect_in "$(kv as owner rpc kin.github.connect.start "{\"token\":\"ghp_good_invented_$RUN\"}")" \
  "invented-owner" "GitHub did not connect as the owner"
looked
# A Kin that read its repos earlier reads them again on the next refresh.
if [[ "$(guard "$OPEN_ORG")" == none ]]; then
  kv clock advance 7h >/dev/null
  looked
fi

[[ "$(guard "$OPEN_ORG")" == "open false -" ]] || fail "$OPEN_ORG reads $(guard "$OPEN_ORG"), not open"
[[ "$(guard "$OPEN_OWN")" == "open false -" ]] || fail "$OPEN_OWN reads $(guard "$OPEN_OWN"), not open"
[[ "$(guard "$FREE")" == "unknown false plan" ]] || fail "$FREE reads $(guard "$FREE"), not the plan's limit"
[[ "$(guard "$OWN_RULES")" == "protected false -" ]] || fail "$OWN_RULES reads $(guard "$OWN_RULES"), not the owner's own"
expect_in "$(kv as owner rpc kin.github.connect.status '{}')" '"open":' "the watch line has no count of open repos"

# A member can't reach it; the owner's Protect all protects two and names the third.
REFUSED="$(kv as zoya rpc kin.github.guard.set "{\"repos\":[\"$OPEN_ORG\"],\"on\":true}" 2>&1 || true)"
expect_in "$REFUSED" "Only the owner or a co-owner" "a member wasn't refused: $REFUSED"
[[ -z "$(rulesets "$OPEN_ORG")" ]] || fail "a member's ask wrote a ruleset"
ALL="$(kv as owner rpc kin.github.guard.set "{\"repos\":[\"$OPEN_ORG\",\"$OPEN_OWN\",\"$FREE\"],\"on\":true}")"
expect_in "$ALL" '"changed":2' "Protect all didn't protect the two it could: $ALL"
expect_in "$ALL" "\"repo\":\"$FREE\"" "Protect all didn't name the repo it couldn't"
expect_in "$ALL" '"problem":"plan"' "Protect all didn't say why"
[[ "$(guard "$OPEN_ORG")" == "protected true -" ]] || fail "$OPEN_ORG isn't protected by Kin"
expect_in "$(rulesets "$OPEN_OWN")" "Kin: only admins change the default branch" "no Kin ruleset on $OPEN_OWN"

# Remove takes off Kin's own and never the owner's.
KEPT="$(kv as owner rpc kin.github.guard.set "{\"repos\":[\"$OWN_RULES\"],\"on\":false}")"
expect_in "$KEPT" '"not_kin"' "Kin offered to remove the owner's own rules"
[[ "$(rulesets "$OWN_RULES")" == "Owner's reviews" ]] || fail "the owner's own ruleset changed"
REMOVED="$(kv as owner rpc kin.github.guard.set "{\"repos\":[\"$OPEN_ORG\"],\"on\":false}")"
expect_in "$REMOVED" '"changed":1' "Remove didn't take Kin's protection off"
[[ -z "$(rulesets "$OPEN_ORG")" ]] || fail "Kin's ruleset is still on $OPEN_ORG"
[[ "$(guard "$OPEN_ORG")" == "open false -" ]] || fail "$OPEN_ORG doesn't read open again"
[[ "$(q "select count(*) from kin_github_owner_uses where use_id like 'guard-%' and repo in ('$OPEN_ORG', '$OPEN_OWN')")" == 3 ]] ||
  fail "the three changes aren't in Done as you lately"
pass "Connections reads open, the plan's limit and the owner's own rules; a member is refused; Protect all protects two and names the third; Remove takes off Kin's ruleset only"
