import type { KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import { gitHubAnswer, repoPath } from "../github/githubRest.ts";
import { KinGitHubApp } from "../github/KinGitHubApp.ts";
import { GITHUB_ACTIONS_INTEGRATION_ID } from "../github/KinRulesets.ts";

const MEMORY_CHECK_NAME = "memory-check";
const MEMORY_CHECK_WORKFLOW = ".github/workflows/memory-check.yml";

const Pull = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  state: Schema.String,
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
});
const decodePull = Schema.decodeUnknownOption(Pull);
const decodePulls = Schema.decodeUnknownOption(Schema.Array(Pull));
const WorkflowRuns = Schema.Struct({
  total_count: Schema.Int,
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      path: Schema.String,
      event: Schema.String,
      head_sha: Schema.String,
      head_branch: Schema.NullOr(Schema.String),
      pull_requests: Schema.Array(
        Schema.Struct({ number: Schema.Int, base: Schema.Struct({ ref: Schema.String }) }),
      ),
    }),
  ),
});
const decodeRuns = Schema.decodeUnknownOption(WorkflowRuns);
const Jobs = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      head_sha: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeJobs = Schema.decodeUnknownOption(Jobs);
const CheckRuns = Schema.Struct({
  total_count: Schema.Int,
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      head_sha: Schema.String,
      app: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
    }),
  ),
});
const decodeChecks = Schema.decodeUnknownOption(CheckRuns);
const decodeMerge = Schema.decodeUnknownOption(
  Schema.Struct({ merged: Schema.Boolean, sha: Schema.String }),
);

export class MemoryPullRequestRefused extends Schema.TaggedError<MemoryPullRequestRefused>()(
  "MemoryPullRequestRefused",
  {
    orgId: Schema.String,
    // Built from fixed text, GitHub's status and error message; never a token.
    reason: Schema.String,
    url: Schema.optional(Schema.String),
  },
) {}

type MemoryPullRequestOutcome =
  | { readonly _tag: "merged"; readonly url: string; readonly commit: string }
  | { readonly _tag: "awaiting_owner"; readonly url: string };

interface MemoryPullRequestInput {
  readonly orgId: KinOrgId;
  readonly repo: RepoSlug;
  readonly branch: string;
  readonly base: string;
  /** The commit Kin pushed to `branch`; nothing else is ever merged. */
  readonly sha: string;
  readonly title: string;
  readonly message: string;
  /** Touches paths CODEOWNERS gives the owner: opened for review, never merged by Kin. */
  readonly ownerReview: boolean;
}

interface ClosedPullRequest {
  readonly url: string;
  readonly branch: string;
  readonly reason: string;
  readonly ownerReview: boolean;
}

export const WRITE_BRANCH_PREFIX = "kin/write/";
export const REVIEW_BRANCH_SUFFIX = "-review";

/**
 * Lands Kin's own memory commits on the protected default branch (TRIG-15). Server-only: never
 * reachable from a lead, worker or MCP tool.
 */
export class MemoryPullRequests extends Context.Service<
  MemoryPullRequests,
  {
    readonly land: (
      input: MemoryPullRequestInput,
    ) => Effect.Effect<MemoryPullRequestOutcome, MemoryPullRequestRefused>;
    /**
     * Closes every open `kin/write/*` PR that no write is waiting on: review PRs whose head is not
     * the commit Kin recorded, and all others. Run it under the writer lock, so no `land` is open.
     */
    readonly sweep: (input: {
      readonly orgId: KinOrgId;
      readonly repo: RepoSlug;
      readonly base: string;
    }) => Effect.Effect<ReadonlyArray<ClosedPullRequest>, MemoryPullRequestRefused>;
  }
>()("t3/kin/memory/MemoryPullRequests") {}

type Verdict =
  | { readonly _tag: "pass" }
  | { readonly _tag: "pending" }
  | { readonly _tag: "fail"; readonly reason: string };

const truncated = (reason: string): Verdict => ({
  _tag: "fail",
  reason: `GitHub listed more ${reason} than one page holds`,
});

/** A `pull_request` run of the memory-check workflow for exactly this PR, branch and commit. */
const isOurRun = (
  input: MemoryPullRequestInput,
  number: number,
  run: (typeof WorkflowRuns.Type)["workflow_runs"][number],
) =>
  run.path === MEMORY_CHECK_WORKFLOW &&
  run.event === "pull_request" &&
  run.head_sha === input.sha &&
  run.head_branch === input.branch &&
  run.pull_requests.some((pull) => pull.number === number && pull.base.ref === input.base);

/**
 * `memory-check` is pinned to the Actions App, which any workflow in the repo can post as, even
 * into another run's check suite. An Actions job's id is its check run's id, so every
 * `memory-check` check run on `sha` must be a job of one of our runs.
 */
const memoryCheckVerdict = (
  sha: string,
  checks: typeof CheckRuns.Type,
  jobs: ReadonlyArray<typeof Jobs.Type>,
): Verdict => {
  if (checks.total_count > checks.check_runs.length) return truncated("check runs");
  if (jobs.some((page) => page.total_count > page.jobs.length)) return truncated("jobs");
  const ours = jobs.flatMap((page) => page.jobs);
  const ids = new Set(ours.map((job) => job.id));
  const foreign = checks.check_runs.some(
    (check) =>
      check.name === MEMORY_CHECK_NAME &&
      (check.app?.id !== GITHUB_ACTIONS_INTEGRATION_ID ||
        check.head_sha !== sha ||
        !ids.has(check.id)),
  );
  if (foreign)
    return {
      _tag: "fail",
      reason: `a ${MEMORY_CHECK_NAME} check that did not come from ${MEMORY_CHECK_WORKFLOW} ran on this commit`,
    };
  const named = ours.filter((job) => job.name === MEMORY_CHECK_NAME && job.head_sha === sha);
  if (named.length === 0 || named.some((job) => job.status !== "completed"))
    return { _tag: "pending" };
  if (named.some((job) => job.conclusion !== "success"))
    return { _tag: "fail", reason: `${MEMORY_CHECK_NAME} failed` };
  return { _tag: "pass" };
};

const PAGE = 100;
const MAX_RUNS = 10;

export const make = Effect.fn("MemoryPullRequests.make")(function* (options: {
  readonly pollInterval: Duration.Input;
  readonly polls: number;
}) {
  const app = yield* KinGitHubApp;
  const client = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;

  const connect = Effect.fn("MemoryPullRequests.connect")(function* (
    orgId: KinOrgId,
    repo: RepoSlug,
  ) {
    const refuse = (reason: string, url?: string) =>
      new MemoryPullRequestRefused({ orgId, reason, ...(url === undefined ? {} : { url }) });
    const minted = yield* app
      .installationToken({
        repo,
        permissions: {
          contents: "write",
          pull_requests: "write",
          checks: "read",
          actions: "read",
        },
        holder: "server",
      })
      .pipe(
        Effect.mapError((error) =>
          refuse(`the Kin GitHub App gave no token for ${repo} (${error._tag})`),
        ),
      );
    const token: Redacted.Redacted<string> = minted.token;
    const base = repoPath(repo);
    const call = (
      operation: string,
      method: "GET" | "POST" | "PUT" | "PATCH",
      path: string,
      body?: unknown,
    ) =>
      gitHubAnswer({
        client,
        operation,
        method,
        path: `${base}${path}`,
        token,
        ...(body === undefined ? {} : { body }),
      }).pipe(Effect.mapError(() => refuse(`could not reach GitHub for ${operation}`)));
    const close = Effect.fn("MemoryPullRequests.close")(function* (number: number, reason: string) {
      yield* call("issues.comment", "POST", `/issues/${number}/comments`, {
        body: `Kin closed this memory PR: ${reason}.`,
      });
      const closed = yield* call("pulls.close", "PATCH", `/pulls/${number}`, { state: "closed" });
      if (closed.status !== 200) return yield* refuse(`GitHub did not close PR #${number}`);
    });
    const records = sql<{
      branch: string;
      head: string;
    }>`SELECT branch, head FROM kin_memory_review_pulls WHERE org_id = ${orgId}`.pipe(
      Effect.mapError(() => refuse("Kin could not read its record of review PRs")),
    );
    return { refuse, call, close, records };
  });

  const land = Effect.fn("MemoryPullRequests.land")(function* (input: MemoryPullRequestInput) {
    yield* Effect.annotateCurrentSpan({ "kin.github.repo": input.repo });
    const { refuse, call, close } = yield* connect(input.orgId, input.repo);
    const describe = (answer: { status: number; message: string }) =>
      `HTTP ${answer.status}${answer.message ? `: ${answer.message}` : ""}`;

    const opened = yield* call("pulls.create", "POST", "/pulls", {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.ownerReview
        ? `Kin's memory changes on paths you review. Kin pushed \`${input.sha}\`; if this PR's head differs, close it. Kin will not merge this.`
        : `Kin merges this once \`${MEMORY_CHECK_NAME}\` passes on the commit it pushed.`,
      maintainer_can_modify: false,
    });
    let pull = opened.status === 201 ? Option.getOrUndefined(decodePull(opened.body)) : undefined;
    // A retry of the same write finds the PR it opened before.
    if (pull === undefined && opened.status === 422) {
      const owner = input.repo.split("/")[0] ?? "";
      const listed = yield* call(
        "pulls.list",
        "GET",
        `/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}&base=${encodeURIComponent(input.base)}`,
      );
      pull = Option.getOrUndefined(decodePulls(listed.body))?.[0];
    }
    if (pull === undefined) return yield* refuse(`GitHub refused the PR (${describe(opened)})`);
    const { number, html_url: url } = pull;

    const refuseAndClose = (reason: string) =>
      close(number, reason).pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not close a refused memory PR", { repo: input.repo, number }),
        ),
        Effect.andThen(Effect.fail(refuse(reason, url))),
      );

    const headIsOurs = Effect.gen(function* () {
      const answer = yield* call("pulls.get", "GET", `/pulls/${number}`);
      const current = answer.status === 200 ? decodePull(answer.body) : Option.none();
      return (
        Option.isSome(current) &&
        current.value.state === "open" &&
        current.value.head.sha === input.sha &&
        current.value.head.ref === input.branch &&
        current.value.head.repo?.full_name.toLowerCase() === input.repo.toLowerCase() &&
        current.value.base.ref === input.base
      );
    });
    if (!(yield* headIsOurs))
      return yield* refuseAndClose("the PR's head is not the commit Kin pushed");
    if (input.ownerReview) {
      // The sweep closes this PR if its head ever stops being the commit recorded here.
      const recorded = yield* sql`INSERT INTO kin_memory_review_pulls (org_id, branch, head)
        VALUES (${input.orgId}, ${input.branch}, ${input.sha})
        ON CONFLICT (org_id, branch) DO UPDATE SET head = excluded.head`.pipe(Effect.result);
      if (recorded._tag === "Failure")
        return yield* refuseAndClose("Kin could not record the commit it pushed");
      return { _tag: "awaiting_owner", url } as const;
    }

    let verdict: Verdict = { _tag: "pending" };
    for (let poll = 0; poll < options.polls && verdict._tag === "pending"; poll++) {
      if (poll > 0) yield* Effect.sleep(options.pollInterval);
      // Check runs first: a real job listed there is already listed by its run.
      const checks = yield* call(
        "checks.list",
        "GET",
        `/commits/${input.sha}/check-runs?check_name=${MEMORY_CHECK_NAME}&filter=all&per_page=${PAGE}`,
      );
      const runs = yield* call(
        "actions.runs",
        "GET",
        `/actions/runs?head_sha=${input.sha}&event=pull_request&per_page=${PAGE}`,
      );
      const decodedChecks = checks.status === 200 ? decodeChecks(checks.body) : Option.none();
      const decodedRuns = runs.status === 200 ? decodeRuns(runs.body) : Option.none();
      if (Option.isNone(decodedChecks) || Option.isNone(decodedRuns)) continue;
      if (decodedRuns.value.total_count > decodedRuns.value.workflow_runs.length) {
        verdict = truncated("workflow runs");
        break;
      }
      const ours = decodedRuns.value.workflow_runs.filter((run) => isOurRun(input, number, run));
      if (ours.length > MAX_RUNS) {
        verdict = truncated("memory-check runs");
        break;
      }
      const jobs = yield* Effect.forEach(ours, (run) =>
        call(
          "actions.jobs",
          "GET",
          `/actions/runs/${run.id}/jobs?filter=all&per_page=${PAGE}`,
        ).pipe(
          Effect.map((answer) => (answer.status === 200 ? decodeJobs(answer.body) : Option.none())),
        ),
      );
      if (jobs.some(Option.isNone)) continue;
      verdict = memoryCheckVerdict(input.sha, decodedChecks.value, jobs.flatMap(Option.toArray));
    }
    if (verdict._tag === "pending")
      return yield* refuseAndClose(`${MEMORY_CHECK_NAME} did not finish in time`);
    if (verdict._tag === "fail") return yield* refuseAndClose(verdict.reason);
    if (!(yield* headIsOurs))
      return yield* refuseAndClose("the PR's head moved after the check passed");

    const [title, ...rest] = input.message.split("\n");
    const merge = yield* call("pulls.merge", "PUT", `/pulls/${number}/merge`, {
      merge_method: "squash",
      sha: input.sha,
      commit_title: title,
      commit_message: rest.join("\n").trim(),
    });
    const merged = merge.status === 200 ? decodeMerge(merge.body) : Option.none();
    if (Option.isSome(merged) && merged.value.merged)
      return { _tag: "merged", url, commit: merged.value.sha } as const;
    return yield* refuseAndClose(`GitHub refused the merge (${describe(merge)})`);
  });

  const sweep = Effect.fn("MemoryPullRequests.sweep")(function* (input: {
    readonly orgId: KinOrgId;
    readonly repo: RepoSlug;
    readonly base: string;
  }) {
    yield* Effect.annotateCurrentSpan({ "kin.github.repo": input.repo });
    const { refuse, call, close, records } = yield* connect(input.orgId, input.repo);
    const listed = yield* call("pulls.list", "GET", `/pulls?state=open&per_page=${PAGE}`);
    const pulls = listed.status === 200 ? decodePulls(listed.body) : Option.none();
    if (Option.isNone(pulls)) return yield* refuse("GitHub did not list the open PRs");
    const recorded = new Map((yield* records).map((row) => [row.branch, row.head]));
    const kept = new Set<string>();
    const closed: Array<ClosedPullRequest> = [];
    for (const pull of pulls.value) {
      const branch = pull.head.ref;
      if (!branch.startsWith(WRITE_BRANCH_PREFIX)) continue;
      const ownerReview = branch.endsWith(REVIEW_BRANCH_SUFFIX);
      const pushed = recorded.get(branch);
      if (
        ownerReview &&
        pushed === pull.head.sha &&
        pull.head.repo?.full_name.toLowerCase() === input.repo.toLowerCase() &&
        pull.base.ref === input.base
      ) {
        kept.add(branch);
        continue;
      }
      const reason = !ownerReview
        ? "no Kin memory write is waiting on it"
        : pushed === undefined
          ? "Kin did not open it"
          : `its head is no longer \`${pushed}\`, the commit Kin pushed`;
      const done = yield* close(pull.number, reason).pipe(Effect.result);
      if (done._tag === "Failure") {
        yield* Effect.logWarning("Could not close an orphaned memory PR", {
          repo: input.repo,
          number: pull.number,
        });
        kept.add(branch);
        continue;
      }
      closed.push({ url: pull.html_url, branch, reason, ownerReview });
    }
    // Only a complete list shows which recorded review PRs are gone.
    if (pulls.value.length >= PAGE) {
      yield* Effect.logWarning("More open memory PRs than one sweep reads", { repo: input.repo });
      return closed;
    }
    for (const branch of recorded.keys()) {
      if (kept.has(branch)) continue;
      yield* sql`DELETE FROM kin_memory_review_pulls
        WHERE org_id = ${input.orgId} AND branch = ${branch}`.pipe(
        Effect.mapError(() => refuse("Kin could not update its record of review PRs")),
      );
    }
    return closed;
  });

  return MemoryPullRequests.of({ land, sweep });
});

/** Polls `memory-check` every 15 seconds for up to the job's 15-minute timeout. */
export const layer = Layer.effect(
  MemoryPullRequests,
  make({ pollInterval: Duration.seconds(15), polls: 60 }),
);
