import type {
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
import {
  guardRows,
  type GuardState,
  type KnownRepo,
  knownRepos,
  repoList,
} from "./githubWatchStore.ts";
import { gitHubApp } from "./KinGitHubApp.ts";

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
const decodeRuleset = Schema.decodeUnknownOption(
  Schema.Struct({
    bypass_actors: Schema.optional(
      Schema.Array(
        Schema.Struct({
          actor_id: Schema.optional(Schema.NullOr(Schema.Number)),
          actor_type: Schema.String,
        }),
      ),
    ),
  }),
);
const decodeClassic = Schema.decodeUnknownOption(
  Schema.Struct({
    required_pull_request_reviews: Schema.optional(
      Schema.Struct({ required_approving_review_count: Schema.optional(Schema.Number) }),
    ),
    lock_branch: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    restrictions: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          apps: Schema.optional(
            Schema.Array(Schema.Struct({ id: Schema.optional(Schema.Number) })),
          ),
        }),
      ),
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
  readonly state: GuardState;
  readonly byKin: boolean;
  readonly problem: KinGitHubGuardProblem | null;
}

type Call = (request: ApiRequest) => Effect.Effect<ApiAnswer>;

/**
 * A bypass actor that can't be Kin's App: people's roles, another App, a deploy key. A write or
 * maintain role, a team or anything else might cover the App, so it doesn't count as a wall.
 * https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset
 */
const keepsAppOut = (
  actor: { readonly actor_id?: number | null | undefined; readonly actor_type: string },
  appId: number | null,
) =>
  (actor.actor_type === "RepositoryRole" && actor.actor_id === 5) ||
  actor.actor_type === "OrganizationAdmin" ||
  actor.actor_type === "EnterpriseOwner" ||
  actor.actor_type === "User" ||
  actor.actor_type === "DeployKey" ||
  (actor.actor_type === "Integration" && appId !== null && actor.actor_id !== appId);

/**
 * `protected` only for a wall Kin's App can't pass: an update rule whose ruleset lets no actor
 * through that could be the App, a locked branch, or pushes kept to others. A required review
 * isn't one (`review`): once someone approves, an App with contents write merges.
 */
const readGuard = Effect.fn("KinBranchGuard.read")(function* (
  call: Call,
  entry: KnownRepo & { readonly branch: string },
  kinRulesetId: number | null,
  appId: number | null,
) {
  const branch = encodeURIComponent(entry.branch);
  const answer = yield* call({ path: `repos/${entry.repo}/rules/branches/${branch}` });
  if (answer.status !== 200)
    return { state: "unknown", byKin: false, problem: problemOf(answer) } satisfies Read;
  const rules = Option.getOrElse(decodeRules(answer.body), () => []);
  const byKin = kinRulesetId !== null && rules.some((rule) => rule.ruleset_id === kinRulesetId);
  const reviews = rules.some(
    (rule) =>
      rule.type === "pull_request" && (rule.parameters?.required_approving_review_count ?? 0) >= 1,
  );
  // An update rule stops the App only if its ruleset's bypass list keeps the App out.
  let unread: KinGitHubGuardProblem | null = null;
  for (const id of new Set(
    rules.flatMap((rule) =>
      rule.type === "update" && rule.ruleset_id !== undefined ? [rule.ruleset_id] : [],
    ),
  )) {
    const ruleset = yield* call({ path: `repos/${entry.repo}/rulesets/${id}` });
    // GitHub shows who bypasses only to a login that may edit the ruleset.
    const actors =
      ruleset.status === 200
        ? Option.getOrUndefined(decodeRuleset(ruleset.body))?.bypass_actors
        : undefined;
    if (actors === undefined) {
      unread ??= ruleset.status === 200 ? "no_admin" : problemOf(ruleset);
      continue;
    }
    if (actors.every((actor) => keepsAppOut(actor, appId)))
      return { state: "protected", byKin, problem: null } satisfies Read;
  }
  if (unread !== null) return { state: "unknown", byKin, problem: unread } satisfies Read;
  if (entry.admin === false) return { state: "unknown", byKin, problem: "no_admin" } satisfies Read;
  const classic = yield* call({ path: `repos/${entry.repo}/branches/${branch}/protection` });
  if (classic.status === 404 && messageOf(classic) === "Branch not protected")
    return { state: reviews ? "review" : "open", byKin, problem: null } satisfies Read;
  // A repo with no commits has no branch to protect: its rules read [] and this says so.
  if (classic.status === 404 && messageOf(classic) === "Branch not found")
    return { state: "unknown", byKin, problem: "no_branch" } satisfies Read;
  if (classic.status !== 200)
    return { state: "unknown", byKin, problem: problemOf(classic) } satisfies Read;
  const held = Option.getOrUndefined(decodeClassic(classic.body));
  const apps = held?.restrictions?.apps ?? [];
  const walled =
    held?.lock_branch?.enabled === true ||
    (held?.restrictions != null &&
      (apps.length === 0 || (appId !== null && !apps.some((app) => app.id === appId))));
  if (walled) return { state: "protected", byKin, problem: null } satisfies Read;
  const classicReviews =
    (held?.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1;
  return {
    state: reviews || classicReviews ? "review" : "open",
    byKin,
    problem: null,
  } satisfies Read;
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

/** Kin's App's id, to tell it from another App on a bypass list; null while there is none. */
const appIdOf = Effect.gen(function* () {
  const app = yield* gitHubApp;
  if (Option.isNone(app)) return null;
  const state = yield* app.value.state();
  return state._tag === "ok" ? state.app.id : null;
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
  const appId = yield* appIdOf;
  let changed = false;
  for (const repo of (yield* repoList(orgId)).filter((entry) => entry.watched)) {
    const key = repo.repo.toLowerCase();
    const entry = withBranch(known.get(key));
    if (entry === undefined) continue;
    const before = saved.get(key);
    const read = yield* readGuard(call, entry, before?.kinRulesetId ?? null, appId);
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
      const read = yield* readGuard(call, entry, null, yield* appIdOf);
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
