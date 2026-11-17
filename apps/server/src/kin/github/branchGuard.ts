import type {
  KinGitHubBranchGuard,
  KinGitHubGuardProblem,
  KinGitHubGuardSetInput,
  KinGitHubGuardSetResult,
  KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import type { ApiAnswer, ApiRequest } from "./GitHubWatch.ts";
import { guardRows, type KnownRepo, knownRepos, repoList } from "./githubWatchStore.ts";

/**
 * Whether Kin's GitHub App can change a watched repo's default branch, and the one ruleset Kin
 * writes to stop it. Read on the repo refresh and written only on the owner's tap in Settings,
 * with his own login: no agent tool reaches this.
 */

export const KIN_RULESET_NAME = "Kin: only admins change the default branch";

/**
 * Only bypass actors may update, delete or force-push the default branch, and only repository
 * admins (and an organisation's owners) bypass. The owner merges and pushes as before; the App,
 * never an admin, can't change the branch by any route. No review is required, so a solo owner
 * is never locked out of his own repo.
 */
const kinRuleset = (organisation: boolean) => ({
  name: KIN_RULESET_NAME,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "update", parameters: { update_allows_fetch_and_merge: false } },
    { type: "deletion" },
    { type: "non_fast_forward" },
  ],
  bypass_actors: [
    // GitHub's id for the repository admin role; its REST docs don't list role ids.
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ...(organisation
      ? [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }]
      : []),
  ],
});

const decodeRules = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      type: Schema.String,
      ruleset_id: Schema.optional(Schema.Number),
      parameters: Schema.optional(
        Schema.Struct({ required_approving_review_count: Schema.optional(Schema.Number) }),
      ),
    }),
  ),
);
const decodeClassic = Schema.decodeUnknownOption(
  Schema.Struct({
    required_pull_request_reviews: Schema.optional(
      Schema.Struct({ required_approving_review_count: Schema.optional(Schema.Number) }),
    ),
    lock_branch: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    restrictions: Schema.optional(
      Schema.NullOr(Schema.Struct({ apps: Schema.optional(Schema.Array(Schema.Unknown)) })),
    ),
  }),
);
const decodeMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));
const decodeCreated = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number }));

const messageOf = (answer: ApiAnswer) =>
  Option.match(decodeMessage(answer.body), {
    onNone: () => null,
    onSome: ({ message }) => message.slice(0, 200),
  });

/** GitHub's refusal, by kind; its plan refusal is the only 403 that says "to enable this feature". */
const problemOf = (answer: ApiAnswer, writing = false): KinGitHubGuardProblem => {
  if (answer.status === 0 || answer.status >= 500) return "unreachable";
  if (answer.status === 403 && (messageOf(answer) ?? "").includes("to enable this feature"))
    return "plan";
  // Reading rules takes only read access; writing them, admin, which GitHub may hide behind a 404.
  if (answer.status === 404 && !writing) return "no_access";
  if (answer.status === 401 || answer.status === 403) return "no_admin";
  return "refused";
};

interface Read {
  readonly state: KinGitHubBranchGuard["state"];
  readonly byKin: boolean;
  readonly problem: KinGitHubGuardProblem | null;
}

/**
 * The rules in force on the branch, then classic protection where they don't stop the App. Each
 * counts when it keeps a non-admin off the branch: restricted updates, a locked branch, pushes
 * kept to named people, or a pull request with at least one approval.
 */
type Call = (request: ApiRequest) => Effect.Effect<ApiAnswer>;

const readGuard = Effect.fn("KinBranchGuard.read")(function* (
  call: Call,
  entry: KnownRepo & { readonly branch: string },
  kinRulesetId: number | null,
) {
  const branch = encodeURIComponent(entry.branch);
  const answer = yield* call({ path: `repos/${entry.repo}/rules/branches/${branch}` });
  if (answer.status !== 200)
    return { state: "unknown", byKin: false, problem: problemOf(answer) } satisfies Read;
  const rules = Option.getOrElse(decodeRules(answer.body), () => []);
  const byKin = kinRulesetId !== null && rules.some((rule) => rule.ruleset_id === kinRulesetId);
  if (
    rules.some(
      (rule) =>
        rule.type === "update" ||
        (rule.type === "pull_request" &&
          (rule.parameters?.required_approving_review_count ?? 0) >= 1),
    )
  )
    return { state: "protected", byKin, problem: null } satisfies Read;
  if (entry.admin === false) return { state: "unknown", byKin, problem: "no_admin" } satisfies Read;
  const classic = yield* call({ path: `repos/${entry.repo}/branches/${branch}/protection` });
  if (classic.status === 404 && messageOf(classic) === "Branch not protected")
    return { state: "open", byKin, problem: null } satisfies Read;
  // A repo with no commits has no branch to protect: its rules read [] and this says so.
  if (classic.status === 404 && messageOf(classic) === "Branch not found")
    return { state: "unknown", byKin, problem: "no_branch" } satisfies Read;
  if (classic.status !== 200)
    return { state: "unknown", byKin, problem: problemOf(classic) } satisfies Read;
  const held = Option.getOrUndefined(decodeClassic(classic.body));
  const stops =
    (held?.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1 ||
    held?.lock_branch?.enabled === true ||
    (held?.restrictions != null && (held.restrictions.apps ?? []).length === 0);
  return { state: stops ? "protected" : "open", byKin, problem: null } satisfies Read;
});

const save = Effect.fn("KinBranchGuard.save")(function* (
  orgId: KinOrgId,
  repo: string,
  branch: string,
  read: Read,
  kinRulesetId: number | null,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_github_branch_guards
      (org_id, repo, branch, state, problem, by_kin, kin_ruleset_id, checked_at)
    VALUES (${orgId}, ${repo}, ${branch}, ${read.state}, ${read.problem}, ${read.byKin ? 1 : 0},
      ${kinRulesetId}, ${now})
    ON CONFLICT (org_id, repo) DO UPDATE SET branch = excluded.branch, state = excluded.state,
      problem = excluded.problem, by_kin = excluded.by_kin,
      kin_ruleset_id = excluded.kin_ruleset_id, checked_at = excluded.checked_at`;
});

const withBranch = (entry: KnownRepo | undefined) =>
  entry?.branch === undefined ? undefined : { ...entry, branch: entry.branch };

/** One read of each watched repo's default branch, on the repo refresh; true when any changed. */
export const checkGuards = Effect.fn("KinBranchGuard.check")(function* (
  call: Call,
  orgId: KinOrgId,
  now: number,
) {
  const known = new Map(
    (yield* knownRepos(orgId)).map((entry) => [entry.repo.toLowerCase(), entry]),
  );
  const saved = yield* guardRows(orgId);
  let changed = false;
  for (const repo of (yield* repoList(orgId)).filter((entry) => entry.watched)) {
    const key = repo.repo.toLowerCase();
    const entry = withBranch(known.get(key));
    if (entry === undefined) continue;
    const before = saved.get(key);
    const read = yield* readGuard(call, entry, before?.kinRulesetId ?? null);
    // A look that didn't reach GitHub keeps what the last one read.
    if (read.problem === "unreachable" && before !== undefined) continue;
    yield* save(orgId, key, entry.branch, read, before?.kinRulesetId ?? null, now);
    changed ||=
      before?.state !== read.state ||
      (before.byKin === 1) !== read.byKin ||
      (before.problem ?? null) !== read.problem;
  }
  return changed;
});

/**
 * The owner's Protect (`on`) or Remove Kin's protection, repo by repo, with his own login. Remove
 * deletes only the ruleset whose id Kin saved when it made it.
 */
export const setGuards = Effect.fn("KinBranchGuard.set")(function* (
  call: Call,
  person: PersonIdentity,
  input: KinGitHubGuardSetInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const refreshes = yield* KinRefreshObserver;
  const known = new Map(
    (yield* knownRepos(input.orgId)).map((entry) => [entry.repo.toLowerCase(), entry]),
  );
  const saved = yield* guardRows(input.orgId);
  const [named] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${input.orgId} AND person_id = ${person.personId}`;
  let changed = 0;
  const failed: Array<KinGitHubGuardSetResult["failed"][number]> = [];
  for (const key of new Set(input.repos.map((name) => name.toLowerCase()))) {
    const entry = withBranch(known.get(key));
    if (entry === undefined) {
      failed.push({ repo: key, problem: "no_access", said: null });
      continue;
    }
    const row = saved.get(key);
    const now = yield* Clock.currentTimeMillis;
    if (input.on) {
      if (row?.state === "protected" && row.byKin === 1) continue;
      // Kin's own earlier ruleset, no longer in force (switched off on GitHub): made again.
      if (row?.kinRulesetId != null)
        yield* call({ method: "DELETE", path: `repos/${entry.repo}/rulesets/${row.kinRulesetId}` });
      const answer = yield* call({
        method: "POST",
        path: `repos/${entry.repo}/rulesets`,
        body: kinRuleset(entry.ownerOrg === true),
      });
      const created = answer.status === 201 ? decodeCreated(answer.body) : Option.none();
      if (Option.isNone(created)) {
        const problem = problemOf(answer, true);
        failed.push({ repo: entry.repo, problem, said: messageOf(answer) });
        // The row says what GitHub just answered, not what the last refresh read.
        if (problem === "plan" || problem === "no_admin")
          yield* save(
            input.orgId,
            key,
            entry.branch,
            { state: "unknown", byKin: false, problem },
            null,
            now,
          );
        continue;
      }
      yield* save(
        input.orgId,
        key,
        entry.branch,
        { state: "protected", byKin: true, problem: null },
        created.value.id,
        now,
      );
    } else {
      if (row?.kinRulesetId == null) {
        failed.push({ repo: entry.repo, problem: "not_kin", said: null });
        continue;
      }
      const answer = yield* call({
        method: "DELETE",
        path: `repos/${entry.repo}/rulesets/${row.kinRulesetId}`,
      });
      if (answer.status !== 204 && answer.status !== 404) {
        failed.push({
          repo: entry.repo,
          problem: problemOf(answer, true),
          said: messageOf(answer),
        });
        continue;
      }
      // What protects the branch now, the owner's own rules included.
      const read = yield* readGuard(call, entry, null);
      yield* save(input.orgId, key, entry.branch, read, null, now);
    }
    changed += 1;
    yield* sql`INSERT INTO kin_github_owner_uses (org_id, use_id, at, agent_name, repo, command)
      VALUES (${input.orgId}, ${`guard-${now}-${input.on ? "on" : "off"}-${key}`}, ${now},
        ${named?.name ?? null}, ${entry.repo},
        ${input.on ? `Protected ${entry.branch} from Kin's App in Settings` : `Removed Kin's protection of ${entry.branch} in Settings`})
      ON CONFLICT DO NOTHING`;
  }
  yield* refreshes.touch(input.orgId, "connections");
  return { changed, failed } satisfies KinGitHubGuardSetResult;
});
