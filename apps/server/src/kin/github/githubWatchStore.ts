import type {
  KinGitHubBranchGuard,
  KinGitHubRepo,
  KinGitHubRepoSetInput,
  KinGitHubWatch,
  KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { configuredRepositories, githubRepoOf } from "../memory/MemoryConfig.ts";
import { ownerZone } from "../work/recordRows.ts";

/**
 * What Kin's GitHub watch stores: the repos the owner's login can push to (refreshed by the poll),
 * his per-repo switches, and how the last look went. Read by the poll, the Connections screen and
 * the agent's `kin_github_watch`.
 */

/**
 * A repo the poll found, with what GitHub said of its account: its id, whether it is an
 * organisation, and whether the owner's login owns that organisation. Older rows hold only the first two fields.
 */
const KnownRepo = Schema.Struct({
  repo: Schema.String,
  fork: Schema.Boolean,
  id: Schema.optional(Schema.Int),
  ownerId: Schema.optional(Schema.Int),
  ownerOrg: Schema.optional(Schema.Boolean),
  ownerAdmin: Schema.optional(Schema.Boolean),
  /** The default branch, and whether the owner's login is an admin of the repo. */
  branch: Schema.optional(Schema.String),
  admin: Schema.optional(Schema.Boolean),
});
export type KnownRepo = typeof KnownRepo.Type;
const decodeKnown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(KnownRepo)));

/** The repos the last poll found, as stored, memory repos left out. */
export const knownRepos = Effect.fn("KinGitHubWatchStore.knownRepos")(function* (orgId: KinOrgId) {
  const row = yield* watchRow(orgId);
  const memory = yield* memoryRepos;
  return Option.getOrElse(decodeKnown(row?.reposJson ?? "[]"), () => []).filter(
    (entry) => !memory.has(entry.repo.toLowerCase()),
  );
});

export interface WatchRow {
  readonly login: string | null;
  readonly startedAt: number;
  readonly notificationsModified: string | null;
  readonly eventsEtag: string | null;
  readonly nextAt: number;
  readonly checkedAt: number | null;
  readonly sinceAt: number;
  readonly problem: string | null;
  readonly reposJson: string | null;
  readonly reposAt: number | null;
}

export const watchRow = Effect.fn("KinGitHubWatchStore.row")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<WatchRow>`SELECT login, started_at AS "startedAt",
      notifications_modified AS "notificationsModified", events_etag AS "eventsEtag",
      next_at AS "nextAt", checked_at AS "checkedAt", since_at AS "sinceAt", problem,
      repos_json AS "reposJson", repos_at AS "reposAt"
    FROM kin_github_watch WHERE org_id = ${orgId} ORDER BY org_id`;
  return row;
});

/**
 * The repos Kin keeps memory in, lowercased. Kin opens its own memory PRs there, as its App or the
 * owner, so watching one would wake an agent for every memory write it makes.
 */
const memoryRepos = Effect.gen(function* () {
  const memory = yield* configuredRepositories;
  return new Set(memory.flatMap((entry) => githubRepoOf(entry.repoUrl)?.toLowerCase() ?? []));
}).pipe(Effect.orElseSucceed(() => new Set<string>()));

export const isMemoryRepo = (repo: string) =>
  memoryRepos.pipe(Effect.map((memory) => memory.has(repo.trim().toLowerCase())));

/** Every repo the poll found, with the owner's switches applied; sorted by name. Never memory. */
export const repoList = Effect.fn("KinGitHubWatchStore.repos")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const known = yield* knownRepos(orgId);
  const prefs = yield* sql<{ repo: string; watched: number | null; mentions: number }>`
    SELECT repo, watched, mentions FROM kin_github_repo_prefs WHERE org_id = ${orgId}
    ORDER BY repo`;
  const byRepo = new Map(prefs.map((pref) => [pref.repo, pref]));
  return known
    .map((entry): KinGitHubRepo => {
      const pref = byRepo.get(entry.repo.toLowerCase());
      return {
        repo: entry.repo,
        fork: entry.fork,
        watched: pref?.watched === null || pref?.watched === undefined || pref.watched === 1,
        mentions: pref?.mentions === 1,
      };
    })
    .toSorted((a, b) => a.repo.localeCompare(b.repo));
});

/** As saved; `review` goes out as `open` with `needsReview`, which a phone older than it ignores. */
export type GuardState = KinGitHubBranchGuard["state"] | "review";

export interface GuardRow {
  readonly repo: string;
  readonly branch: string;
  readonly state: GuardState;
  readonly problem: KinGitHubBranchGuard["problem"] | null;
  readonly byKin: number;
  readonly kinRulesetId: number | null;
}

/** What the last refresh read of each repo's default branch, by lowercased repo. */
export const guardRows = Effect.fn("KinGitHubWatchStore.guards")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<GuardRow>`SELECT repo, branch, state, problem, by_kin AS "byKin",
      kin_ruleset_id AS "kinRulesetId"
    FROM kin_github_branch_guards WHERE org_id = ${orgId} ORDER BY repo`;
  return new Map(rows.map((row) => [row.repo, row]));
});

/** Each watched repo with its default branch's protection, once a refresh has read it. */
export const withGuards = Effect.fn("KinGitHubWatchStore.withGuards")(function* (
  orgId: KinOrgId,
  repos: ReadonlyArray<KinGitHubRepo>,
) {
  const guards = yield* guardRows(orgId);
  return repos.map((repo): KinGitHubRepo => {
    const row = repo.watched ? guards.get(repo.repo.toLowerCase()) : undefined;
    return row === undefined
      ? repo
      : {
          ...repo,
          guard: {
            state: row.state === "review" ? "open" : row.state,
            branch: row.branch,
            byKin: row.byKin === 1,
            ...(row.state === "review" ? { needsReview: true } : {}),
            ...(row.problem === null || row.problem === undefined ? {} : { problem: row.problem }),
          },
        };
  });
});

/** The accounts the company's repos are under (the owner's login, his organisations), by name. */
export const companyAccounts = Effect.fn("KinGitHubWatchStore.companyAccounts")(function* (
  orgId: KinOrgId,
) {
  const accounts = new Map<string, string>();
  for (const entry of yield* knownRepos(orgId)) {
    const account = entry.repo.split("/")[0] ?? "";
    if (account !== "" && !accounts.has(account.toLowerCase()))
      accounts.set(account.toLowerCase(), account);
  }
  return [...accounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, name]) => name);
});

/** A repo of the company's (the owner's or his organisations', where he can push), if it is one. */
export const companyRepo = Effect.fn("KinGitHubWatchStore.companyRepo")(function* (
  orgId: KinOrgId,
  repo: string,
) {
  return (yield* repoList(orgId)).find(
    (entry) => entry.repo.toLowerCase() === repo.trim().toLowerCase(),
  );
});

export const setRepo = Effect.fn("KinGitHubWatchStore.setRepo")(function* (
  input: KinGitHubRepoSetInput,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (input.repo === null) {
    yield* sql`UPDATE kin_github_repo_prefs SET watched = NULL, updated_at = ${now}
      WHERE org_id = ${input.orgId}`;
    return yield* repoList(input.orgId);
  }
  const repo = input.repo.trim().toLowerCase();
  const watched = input.watched === undefined ? null : input.watched ? 1 : 0;
  const mentions = input.mentions === undefined ? null : input.mentions ? 1 : 0;
  yield* sql`INSERT INTO kin_github_repo_prefs (org_id, repo, watched, mentions, updated_at)
    VALUES (${input.orgId}, ${repo}, ${watched}, ${mentions ?? 0}, ${now})
    ON CONFLICT (org_id, repo) DO UPDATE SET
      watched = CASE WHEN ${input.watched === undefined ? 1 : 0} = 1 THEN watched ELSE excluded.watched END,
      mentions = CASE WHEN ${input.mentions === undefined ? 1 : 0} = 1 THEN mentions ELSE excluded.mentions END,
      updated_at = excluded.updated_at`;
  return yield* repoList(input.orgId);
});

/** "Watching: N repos · last checked … · 3 things handled today"; undefined before the first look. */
export const watchSummary = Effect.fn("KinGitHubWatchStore.summary")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* watchRow(orgId);
  if (row === undefined) return undefined;
  const zone = yield* ownerZone(orgId);
  const midnight = DateTime.toEpochMillis(
    DateTime.startOf(DateTime.makeZonedUnsafe(now, { timeZone: zone }), "day"),
  );
  const [handled] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
    FROM kin_github_handled WHERE org_id = ${orgId} AND outcome = 'woke' AND at >= ${midnight}`;
  const watched = (yield* repoList(orgId)).filter((repo) => repo.watched);
  const guards = yield* guardRows(orgId);
  return {
    repos: watched.length,
    checkedAt: row.checkedAt,
    handledToday: handled?.count ?? 0,
    problem: row.problem,
    open: watched.filter((repo) => {
      const state = guards.get(repo.repo.toLowerCase())?.state;
      return state === "open" || state === "review";
    }).length,
  } satisfies KinGitHubWatch;
});
