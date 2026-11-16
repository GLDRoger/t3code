import type { KinGitHubRepo, KinGitHubRepoSetInput, KinGitHubWatch, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerZone } from "../work/recordRows.ts";

/**
 * What Kin's GitHub watch stores: the repos the owner's login can push to (refreshed by the poll),
 * his per-repo switches, and how the last look went. Read by the poll, the Connections screen and
 * the agent's `kin_github_watch`.
 */

const KnownRepo = Schema.Struct({ repo: Schema.String, fork: Schema.Boolean });
const decodeKnown = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(KnownRepo)),
);

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

/** Every repo the poll found, with the owner's switches applied; sorted by name. */
export const repoList = Effect.fn("KinGitHubWatchStore.repos")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* watchRow(orgId);
  const known = Option.getOrElse(decodeKnown(row?.reposJson ?? "[]"), () => []);
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
        watched: pref?.watched === null || pref?.watched === undefined ? !entry.fork : pref.watched === 1,
        mentions: pref?.mentions === 1,
      };
    })
    .toSorted((a, b) => a.repo.localeCompare(b.repo));
});

/** A repo of the company's (the owner's or his organisations', where he can push), if it is one. */
export const companyRepo = Effect.fn("KinGitHubWatchStore.companyRepo")(function* (
  orgId: KinOrgId,
  repo: string,
) {
  return (yield* repoList(orgId)).find((entry) => entry.repo.toLowerCase() === repo.trim().toLowerCase());
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
  return {
    repos: (yield* repoList(orgId)).filter((repo) => repo.watched).length,
    checkedAt: row.checkedAt,
    handledToday: handled?.count ?? 0,
    problem: row.problem,
  } satisfies KinGitHubWatch;
});
