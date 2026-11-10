import { KinChatError, RepoSlug } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { KinGithubRepoScope } from "../triggers/githubEvents.ts";
import { gitHubAnswer, isGitHubRateLimit, repoPath } from "./githubRest.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import type { KinGitHubPermissionSet } from "./KinGitHubPermissions.ts";

// Read-only on purpose: these back a lead's MCP tools, which must never write.
const READ_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
} as const satisfies KinGitHubPermissionSet;
export const PULLS_CAP = 30;
export const RUNS_CAP = 20;
export const CALLS_PER_WAKEUP = 20;
const BODY_CAP = 2_000;
const ENRICH_CONCURRENCY = 6;
const REQUEST_TIMEOUT = "10 seconds";
const CALL_TIMEOUT = "30 seconds";
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const TRACKED_WAKEUPS = 500;

export const NOT_CONNECTED =
  "GitHub isn't connected on this host, so repos, PRs and CI can't be read here.";
const NOT_FOUND = "No such repository, or it isn't one this organization can read.";

export const PullsInput = Schema.Struct({
  repo: Schema.String.annotate({ description: "owner/name, from kin_github_repos." }),
  state: Schema.optional(Schema.Literals(["open", "closed", "all"])),
});
export const PullInput = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const RunsInput = Schema.Struct({
  repo: Schema.String,
  branch: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
});
export const ReposResult = Schema.Struct({ repos: Schema.Array(Schema.String) });

const Login = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const PullListItem = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  user: Login,
  draft: Schema.optional(Schema.Boolean),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  updated_at: Schema.String,
  html_url: Schema.String,
  requested_reviewers: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
});
const decodePulls = Schema.decodeUnknownOption(Schema.Array(PullListItem));
const PullDetail = Schema.Struct({
  ...PullListItem.fields,
  body: Schema.NullOr(Schema.String),
  merged: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  mergeable_state: Schema.optional(Schema.String),
  changed_files: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
});
const decodePull = Schema.decodeUnknownOption(PullDetail);
const Review = Schema.Struct({ user: Login, state: Schema.String });
type Review = typeof Review.Type;
const decodeReviews = Schema.decodeUnknownOption(Schema.Array(Review));
const CheckRun = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.NullOr(Schema.String),
});
type CheckRuns = ReadonlyArray<typeof CheckRun.Type>;
const decodeCheckRuns = Schema.decodeUnknownOption(
  Schema.Struct({ check_runs: Schema.Array(CheckRun) }),
);
const CommitStatus = Schema.Struct({
  context: Schema.String,
  state: Schema.String,
  target_url: Schema.NullOr(Schema.String),
});
type Statuses = ReadonlyArray<typeof CommitStatus.Type>;
const decodeStatus = Schema.decodeUnknownOption(
  Schema.Struct({ statuses: Schema.Array(CommitStatus) }),
);
const decodeRuns = Schema.decodeUnknownOption(
  Schema.Struct({
    workflow_runs: Schema.Array(
      Schema.Struct({
        name: Schema.NullOr(Schema.String),
        head_branch: Schema.NullOr(Schema.String),
        status: Schema.NullOr(Schema.String),
        conclusion: Schema.NullOr(Schema.String),
        html_url: Schema.String,
        updated_at: Schema.String,
      }),
    ),
  }),
);

const isRepoSlug = Schema.is(RepoSlug);

export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";
export type CheckState = "failure" | "pending" | "success" | "none";

export interface KinPullSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string | null;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly updatedAt: string;
  readonly reviewDecision: ReviewDecision;
  readonly checks: CheckState;
  readonly url: string;
}

export interface KinPullDetail extends KinPullSummary {
  readonly merged: boolean;
  readonly body: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  readonly reviews: ReadonlyArray<{ readonly reviewer: string | null; readonly state: string }>;
  readonly failingChecks: ReadonlyArray<{ readonly name: string; readonly url: string | null }>;
  readonly mergeable: boolean | null;
  readonly mergeableState: string | null;
}

export interface KinWorkflowRun {
  readonly name: string | null;
  readonly branch: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly url: string;
  readonly updatedAt: string;
}

/**
 * A lead's read-only view of the org's repos (`KIN_GITHUB_REPOS` minus memory repos), with the
 * Kin App's read token. Every failure is a short `KinChatError` that never carries a credential.
 */
export class KinRepoReads extends Context.Service<
  KinRepoReads,
  {
    readonly repos: (wakeupId: string) => Effect.Effect<typeof ReposResult.Type, KinChatError>;
    readonly pulls: (
      wakeupId: string,
      input: typeof PullsInput.Type,
    ) => Effect.Effect<
      { readonly repo: string; readonly pulls: ReadonlyArray<KinPullSummary> },
      KinChatError
    >;
    readonly pull: (
      wakeupId: string,
      input: typeof PullInput.Type,
    ) => Effect.Effect<{ readonly repo: string; readonly pull: KinPullDetail }, KinChatError>;
    readonly runs: (
      wakeupId: string,
      input: typeof RunsInput.Type,
    ) => Effect.Effect<
      { readonly repo: string; readonly runs: ReadonlyArray<KinWorkflowRun> },
      KinChatError
    >;
  }
>()("t3/kin/github/KinRepoReads") {}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

const failingChecks = (runs: CheckRuns, statuses: Statuses) => [
  ...runs
    .filter((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion))
    .map((run) => ({ name: run.name, url: run.html_url })),
  ...statuses
    .filter((status) => status.state === "failure" || status.state === "error")
    .map((status) => ({ name: status.context, url: status.target_url })),
];

const checkState = (runs: CheckRuns, statuses: Statuses): CheckState => {
  if (failingChecks(runs, statuses).length > 0) return "failure";
  if (runs.some((run) => run.status !== "completed") || statuses.some((s) => s.state === "pending"))
    return "pending";
  return runs.length + statuses.length > 0 ? "success" : "none";
};

/** Each reviewer's latest approving or blocking review decides, as GitHub's own badge does. */
const reviewDecision = (reviews: ReadonlyArray<Review>, requested: number): ReviewDecision => {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (
      review.user === null ||
      !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
    )
      continue;
    latest.set(review.user.login.toLowerCase(), review.state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return requested > 0 ? "review_required" : "none";
};

const unavailable = (message: string) => new KinChatError({ reason: "unavailable", message });
const notFound = () => new KinChatError({ reason: "not_found", message: NOT_FOUND });

const make = Effect.gen(function* () {
  const app = yield* KinGitHubApp.KinGitHubApp;
  const client = yield* HttpClient.HttpClient;
  const scope = yield* KinGithubRepoScope;
  const tokens = new Map<
    string,
    { readonly token: Redacted.Redacted<string>; readonly expiresAt: number }
  >();
  const calls = new Map<string, number>();

  const spend = Effect.fnUntraced(function* (wakeupId: string) {
    const used = (calls.get(wakeupId) ?? 0) + 1;
    if (used > CALLS_PER_WAKEUP)
      return yield* new KinChatError({
        reason: "limit",
        message: `GitHub read limit reached for this wake-up (${CALLS_PER_WAKEUP} calls).`,
      });
    calls.delete(wakeupId);
    calls.set(wakeupId, used);
    if (calls.size > TRACKED_WAKEUPS) calls.delete(calls.keys().next().value ?? "");
  });

  /** The scoped spelling of `repo`, or not found before any request is made. */
  const scoped = (repo: string) => {
    const wanted = repo.trim();
    const match = isRepoSlug(wanted)
      ? scope.repos.find((entry) => entry.toLowerCase() === wanted.toLowerCase())
      : undefined;
    return match === undefined ? Effect.fail(notFound()) : Effect.succeed(match as RepoSlug);
  };

  const tokenFor = Effect.fnUntraced(function* (repo: RepoSlug) {
    const key = repo.toLowerCase();
    const now = yield* Clock.currentTimeMillis;
    const cached = tokens.get(key);
    if (cached !== undefined && now < cached.expiresAt - TOKEN_REUSE_MARGIN_MS) return cached.token;
    tokens.delete(key);
    const minted = yield* app
      .installationToken({ repo, permissions: READ_PERMISSIONS, holder: "server" })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Kin lead GitHub read token refused", { repo, errorTag: error._tag }),
        ),
        Effect.mapError(() => unavailable("GitHub refused Kin's read access to this repository.")),
      );
    const expiresAt = Date.parse(minted.expiresAt);
    if (Number.isFinite(expiresAt)) tokens.set(key, { token: minted.token, expiresAt });
    return minted.token;
  });

  const get = Effect.fnUntraced(function* <A>(
    repo: RepoSlug,
    operation: string,
    path: string,
    decode: (body: unknown) => Option.Option<A>,
  ) {
    const token = yield* tokenFor(repo);
    const answer = yield* gitHubAnswer({
      client,
      operation,
      method: "GET",
      path: `${repoPath(repo)}${path}`,
      token,
      timeout: REQUEST_TIMEOUT,
    }).pipe(Effect.mapError(() => unavailable("GitHub didn't answer. Try again shortly.")));
    if (answer.status === 401) tokens.delete(repo.toLowerCase());
    if (isGitHubRateLimit(answer))
      return yield* unavailable("GitHub is rate-limiting Kin right now. Try again later.");
    if (answer.status === 404) return yield* notFound();
    if (answer.status !== 200) {
      yield* Effect.logWarning("Kin lead GitHub read failed", {
        repo,
        operation,
        status: answer.status,
      });
      return yield* unavailable("GitHub couldn't be read right now.");
    }
    const body = decode(answer.body);
    if (Option.isNone(body))
      return yield* unavailable("GitHub's answer wasn't in the expected shape.");
    return body.value;
  });

  const checksFor = (repo: RepoSlug, sha: string) =>
    Effect.all(
      [
        get(
          repo,
          "checks.listForRef",
          `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
          decodeCheckRuns,
        ),
        get(
          repo,
          "repos.getCombinedStatus",
          `/commits/${encodeURIComponent(sha)}/status?per_page=100`,
          decodeStatus,
        ),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map(([runs, status]) => ({ runs: runs.check_runs, statuses: status.statuses })));

  const reviewsFor = (repo: RepoSlug, number: number) =>
    get(repo, "pulls.listReviews", `/pulls/${number}/reviews?per_page=100`, decodeReviews);

  const summary = (
    pull: typeof PullListItem.Type,
    reviews: ReadonlyArray<Review>,
    checks: { readonly runs: CheckRuns; readonly statuses: Statuses },
  ): KinPullSummary => ({
    number: pull.number,
    title: pull.title,
    state: pull.state,
    author: pull.user?.login ?? null,
    draft: pull.draft ?? false,
    headBranch: pull.head.ref,
    updatedAt: pull.updated_at,
    reviewDecision: reviewDecision(reviews, pull.requested_reviewers?.length ?? 0),
    checks: checkState(checks.runs, checks.statuses),
    url: pull.html_url,
  });

  /** One tool call: counted, scoped and time-boxed. */
  const call = <A>(
    wakeupId: string,
    repo: string,
    read: (repo: RepoSlug) => Effect.Effect<A, KinChatError>,
  ) =>
    spend(wakeupId).pipe(
      Effect.andThen(scoped(repo)),
      Effect.flatMap(read),
      Effect.timeoutOrElse({
        duration: CALL_TIMEOUT,
        orElse: () => Effect.fail(unavailable("GitHub didn't answer in time. Try again shortly.")),
      }),
    );

  return KinRepoReads.of({
    repos: Effect.fn("KinRepoReads.repos")(function* (wakeupId) {
      yield* spend(wakeupId);
      return { repos: [...scope.repos] };
    }),
    pulls: Effect.fn("KinRepoReads.pulls")(function* (wakeupId, input) {
      return yield* call(wakeupId, input.repo, (repo) =>
        Effect.gen(function* () {
          const pulls = yield* get(
            repo,
            "pulls.list",
            `/pulls?state=${input.state ?? "open"}&sort=updated&direction=desc&per_page=${PULLS_CAP}`,
            decodePulls,
          );
          const enriched = yield* Effect.forEach(
            pulls.slice(0, PULLS_CAP),
            (pull) =>
              Effect.all([reviewsFor(repo, pull.number), checksFor(repo, pull.head.sha)], {
                concurrency: 2,
              }).pipe(Effect.map(([reviews, checks]) => summary(pull, reviews, checks))),
            { concurrency: ENRICH_CONCURRENCY },
          );
          return { repo, pulls: enriched };
        }),
      );
    }),
    pull: Effect.fn("KinRepoReads.pull")(function* (wakeupId, input) {
      return yield* call(wakeupId, input.repo, (repo) =>
        Effect.gen(function* () {
          const pull = yield* get(repo, "pulls.get", `/pulls/${input.number}`, decodePull);
          const [reviews, checks] = yield* Effect.all(
            [reviewsFor(repo, pull.number), checksFor(repo, pull.head.sha)],
            { concurrency: 2 },
          );
          const body = pull.body ?? "";
          return {
            repo,
            pull: {
              ...summary(pull, reviews, checks),
              merged: pull.merged,
              body: body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}…[truncated]` : body,
              changedFiles: pull.changed_files,
              additions: pull.additions,
              deletions: pull.deletions,
              reviews: reviews.map((review) => ({
                reviewer: review.user?.login ?? null,
                state: review.state,
              })),
              failingChecks: failingChecks(checks.runs, checks.statuses),
              mergeable: pull.mergeable,
              mergeableState: pull.mergeable_state ?? null,
            } satisfies KinPullDetail,
          };
        }),
      );
    }),
    runs: Effect.fn("KinRepoReads.runs")(function* (wakeupId, input) {
      return yield* call(wakeupId, input.repo, (repo) =>
        Effect.gen(function* () {
          const branch =
            input.branch === undefined ? "" : `&branch=${encodeURIComponent(input.branch)}`;
          const answer = yield* get(
            repo,
            "actions.listWorkflowRunsForRepo",
            `/actions/runs?per_page=${RUNS_CAP}${branch}`,
            decodeRuns,
          );
          return {
            repo,
            runs: answer.workflow_runs.slice(0, RUNS_CAP).map((run): KinWorkflowRun => ({
              name: run.name,
              branch: run.head_branch,
              status: run.status,
              conclusion: run.conclusion,
              url: run.html_url,
              updatedAt: run.updated_at,
            })),
          };
        }),
      );
    }),
  });
});

/** Needs the Kin App, an HTTP client and the org's repo scope. */
export const layer = Layer.effect(KinRepoReads, make);

const notConnected = () => Effect.fail(unavailable(NOT_CONNECTED));
/** When the Kin App isn't configured on this host: every read answers with one plain line. */
export const notConnectedLayer = Layer.succeed(
  KinRepoReads,
  KinRepoReads.of({
    repos: notConnected,
    pulls: notConnected,
    pull: notConnected,
    runs: notConnected,
  }),
);
