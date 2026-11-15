import type { KinGithubEvent, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** PR state from webhooks, what the pulse's code senses read: no model and no GitHub call. */
export type PullState = "open" | "closed" | "merged";
export interface PullRow {
  readonly title: string;
  readonly author: string | null;
  readonly url: string;
  readonly draft: boolean;
  readonly state: PullState;
  readonly headSha: string | null;
  readonly headRef: string | null;
  readonly headRepo: string | null;
  readonly openedAt: number;
  readonly reviewRequestedAt: number | null;
  readonly review: "approved" | "changes_requested" | null;
  readonly checks: "success" | "failure" | "pending" | null;
  readonly checksSha: string | null;
  readonly readyAt: number | null;
}

const PullFields = Schema.Struct({
  number: Schema.Int,
  title: Schema.optional(Schema.String),
  html_url: Schema.String,
  state: Schema.optional(Schema.String),
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  created_at: Schema.optional(Schema.String),
  head: Schema.optional(
    Schema.Struct({
      sha: Schema.String,
      ref: Schema.String,
      repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
    }),
  ),
});
const EventFields = Schema.Struct({
  action: Schema.optional(Schema.String),
  pull_request: Schema.optional(PullFields),
  review: Schema.optional(Schema.Struct({ state: Schema.String })),
  check_suite: Schema.optional(
    Schema.Struct({
      head_sha: Schema.String,
      status: Schema.optional(Schema.NullOr(Schema.String)),
      conclusion: Schema.optional(Schema.NullOr(Schema.String)),
      pull_requests: Schema.optional(Schema.Array(Schema.Struct({ number: Schema.Int }))),
    }),
  ),
});
const decodeFields = Schema.decodeUnknownOption(EventFields);
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

const withReady = (row: PullRow, at: number): PullRow => ({
  ...row,
  readyAt:
    row.state === "open" && !row.draft && row.review === "approved" && row.checks === "success"
      ? (row.readyAt ?? at)
      : null,
});

/** The row a pull request event leaves: undefined when the event says nothing about one. */
export const nextPullRow = (
  stored: PullRow | undefined,
  event: Pick<KinGithubEvent, "event" | "action" | "payload" | "receivedAt">,
  number: number,
): PullRow | undefined => {
  const fields = Option.getOrUndefined(decodeFields(event.payload));
  if (fields === undefined) return undefined;
  const at = Date.parse(event.receivedAt);
  const pull = fields.pull_request;
  if (pull !== undefined && pull.number === number) {
    const headSha = pull.head?.sha ?? stored?.headSha ?? null;
    const moved = stored !== undefined && headSha !== stored.headSha;
    const opened = pull.created_at === undefined ? Number.NaN : Date.parse(pull.created_at);
    let row: PullRow = {
      title: pull.title ?? stored?.title ?? "",
      author: pull.user?.login ?? stored?.author ?? null,
      url: pull.html_url,
      draft: pull.draft ?? stored?.draft ?? false,
      state: pull.merged === true ? "merged" : pull.state === "closed" ? "closed" : "open",
      headSha,
      headRef: pull.head?.ref ?? stored?.headRef ?? null,
      headRepo: pull.head?.repo?.full_name ?? stored?.headRepo ?? null,
      openedAt: stored?.openedAt ?? (Number.isFinite(opened) ? opened : at),
      reviewRequestedAt: stored?.reviewRequestedAt ?? null,
      review: stored?.review ?? null,
      checks: moved ? null : (stored?.checks ?? null),
      checksSha: moved ? null : (stored?.checksSha ?? null),
      readyAt: stored?.readyAt ?? null,
    };
    if (event.event === "pull_request" && event.action === "review_requested")
      row = { ...row, reviewRequestedAt: row.reviewRequestedAt ?? at };
    if (event.event === "pull_request_review" && event.action === "submitted") {
      const state = fields.review?.state.toLowerCase();
      if (state === "approved" || state === "changes_requested")
        row = { ...row, review: state, reviewRequestedAt: null };
      else if (state === "commented") row = { ...row, reviewRequestedAt: null };
    }
    if (event.event === "pull_request_review" && event.action === "dismissed")
      row = { ...row, review: null };
    return withReady(row, at);
  }
  const suite = fields.check_suite;
  if (event.event === "check_suite" && suite !== undefined && stored !== undefined) {
    if (stored.headSha !== null && stored.headSha !== suite.head_sha) return undefined;
    const failedBefore = stored.checksSha === suite.head_sha && stored.checks === "failure";
    const outcome =
      suite.conclusion != null && FAILED.has(suite.conclusion)
        ? "failure"
        : failedBefore
          ? "failure"
          : suite.status === "completed"
            ? "success"
            : "pending";
    return withReady({ ...stored, checks: outcome, checksSha: suite.head_sha }, at);
  }
  return undefined;
};

interface StoredPull extends Omit<PullRow, "draft"> {
  readonly draft: number;
}

/** Keeps `kin_pull_requests` current from one in-scope webhook event. */
export const recordPullRequestEvent = Effect.fn("KinPullRequestCare.record")(function* (
  orgId: KinOrgId,
  event: KinGithubEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = event.repo.toLowerCase();
  const fields = Option.getOrUndefined(decodeFields(event.payload));
  const numbers =
    event.number !== null
      ? [event.number]
      : (fields?.check_suite?.pull_requests ?? []).map((pull) => pull.number);
  const now = yield* Clock.currentTimeMillis;
  for (const number of numbers) {
    const [found] = yield* sql<StoredPull>`SELECT title, author, url, draft, state,
        head_sha AS "headSha", head_ref AS "headRef", head_repo AS "headRepo",
        opened_at AS "openedAt", review_requested_at AS "reviewRequestedAt", review, checks,
        checks_sha AS "checksSha", ready_at AS "readyAt"
      FROM kin_pull_requests WHERE org_id = ${orgId} AND repo = ${repo} AND number = ${number}
      ORDER BY number`;
    const stored = found === undefined ? undefined : { ...found, draft: found.draft === 1 };
    const next = nextPullRow(stored, event, number);
    if (next === undefined) continue;
    yield* sql`INSERT INTO kin_pull_requests (org_id, repo, number, title, author, url, draft,
        state, head_sha, head_ref, head_repo, opened_at, review_requested_at, review, checks,
        checks_sha, ready_at, updated_at)
      VALUES (${orgId}, ${repo}, ${number}, ${next.title}, ${next.author}, ${next.url},
        ${next.draft ? 1 : 0}, ${next.state}, ${next.headSha}, ${next.headRef}, ${next.headRepo},
        ${next.openedAt}, ${next.reviewRequestedAt}, ${next.review}, ${next.checks},
        ${next.checksSha}, ${next.readyAt}, ${now})
      ON CONFLICT (org_id, repo, number) DO UPDATE SET title = excluded.title,
        author = excluded.author, url = excluded.url, draft = excluded.draft,
        state = excluded.state, head_sha = excluded.head_sha, head_ref = excluded.head_ref,
        head_repo = excluded.head_repo, review_requested_at = excluded.review_requested_at,
        review = excluded.review, checks = excluded.checks, checks_sha = excluded.checks_sha,
        ready_at = excluded.ready_at, updated_at = excluded.updated_at`;
  }
});
