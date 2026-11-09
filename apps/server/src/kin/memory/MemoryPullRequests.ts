import type { KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

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
  workflow_runs: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      event: Schema.String,
      head_sha: Schema.String,
      check_suite_id: Schema.optional(Schema.NullOr(Schema.Int)),
    }),
  ),
});
const decodeRuns = Schema.decodeUnknownOption(WorkflowRuns);
const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      head_sha: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      app: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
      check_suite: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
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
  }
>()("t3/kin/memory/MemoryPullRequests") {}

type Verdict =
  | { readonly _tag: "pass" }
  | { readonly _tag: "pending" }
  | { readonly _tag: "fail"; readonly reason: string };

/**
 * `memory-check` is pinned to the Actions App, which any workflow in the repo can post as, so only
 * a check run from a `pull_request` run of the memory-check workflow on `sha` counts.
 */
const memoryCheckVerdict = (
  sha: string,
  runs: typeof WorkflowRuns.Type,
  checks: typeof CheckRuns.Type,
): Verdict => {
  const suites = new Set(
    runs.workflow_runs
      .filter(
        (run) =>
          run.path === MEMORY_CHECK_WORKFLOW &&
          run.event === "pull_request" &&
          run.head_sha === sha,
      )
      .flatMap((run) => (run.check_suite_id == null ? [] : [run.check_suite_id])),
  );
  const named = checks.check_runs.filter((check) => check.name === MEMORY_CHECK_NAME);
  const foreign = named.some(
    (check) =>
      check.app?.id !== GITHUB_ACTIONS_INTEGRATION_ID ||
      check.head_sha !== sha ||
      check.check_suite === null ||
      !suites.has(check.check_suite.id),
  );
  if (foreign)
    return {
      _tag: "fail",
      reason: `a ${MEMORY_CHECK_NAME} check that did not come from ${MEMORY_CHECK_WORKFLOW} ran on this commit`,
    };
  if (named.length === 0 || named.some((check) => check.status !== "completed"))
    return { _tag: "pending" };
  if (named.some((check) => check.conclusion !== "success"))
    return { _tag: "fail", reason: `${MEMORY_CHECK_NAME} failed` };
  return { _tag: "pass" };
};

export const make = Effect.fn("MemoryPullRequests.make")(function* (options: {
  readonly pollInterval: Duration.Input;
  readonly polls: number;
}) {
  const app = yield* KinGitHubApp;
  const client = yield* HttpClient.HttpClient;

  const land = Effect.fn("MemoryPullRequests.land")(function* (input: MemoryPullRequestInput) {
    yield* Effect.annotateCurrentSpan({ "kin.github.repo": input.repo });
    const refuse = (reason: string, url?: string) =>
      new MemoryPullRequestRefused({
        orgId: input.orgId,
        reason,
        ...(url === undefined ? {} : { url }),
      });
    const minted = yield* app
      .installationToken({
        repo: input.repo,
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
          refuse(`the Kin GitHub App gave no token for ${input.repo} (${error._tag})`),
        ),
      );
    const token: Redacted.Redacted<string> = minted.token;
    const base = repoPath(input.repo);
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
    const describe = (answer: { status: number; message: string }) =>
      `HTTP ${answer.status}${answer.message ? `: ${answer.message}` : ""}`;

    const opened = yield* call("pulls.create", "POST", "/pulls", {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.ownerReview
        ? "Kin's memory changes on paths you review. Kin will not merge this."
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

    const close = Effect.fn("MemoryPullRequests.close")(
      function* (reason: string) {
        yield* call("issues.comment", "POST", `/issues/${number}/comments`, {
          body: `Kin closed this memory PR: ${reason}.`,
        });
        yield* call("pulls.close", "PATCH", `/pulls/${number}`, { state: "closed" });
      },
      Effect.catch(() =>
        Effect.logWarning("Could not close a refused memory PR", { repo: input.repo, number }),
      ),
    );
    const refuseAndClose = (reason: string) =>
      close(reason).pipe(Effect.andThen(Effect.fail(refuse(reason, url))));

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
    if (input.ownerReview) return { _tag: "awaiting_owner", url } as const;

    let verdict: Verdict = { _tag: "pending" };
    for (let poll = 0; poll < options.polls && verdict._tag === "pending"; poll++) {
      if (poll > 0) yield* Effect.sleep(options.pollInterval);
      const runs = yield* call(
        "actions.runs",
        "GET",
        `/actions/runs?head_sha=${input.sha}&event=pull_request&per_page=100`,
      );
      const checks = yield* call(
        "checks.list",
        "GET",
        `/commits/${input.sha}/check-runs?check_name=${MEMORY_CHECK_NAME}&per_page=100`,
      );
      const decodedRuns = runs.status === 200 ? decodeRuns(runs.body) : Option.none();
      const decodedChecks = checks.status === 200 ? decodeChecks(checks.body) : Option.none();
      if (Option.isSome(decodedRuns) && Option.isSome(decodedChecks))
        verdict = memoryCheckVerdict(input.sha, decodedRuns.value, decodedChecks.value);
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

  return MemoryPullRequests.of({ land });
});

/** Polls `memory-check` every 15 seconds for up to the job's 15-minute timeout. */
export const layer = Layer.effect(
  MemoryPullRequests,
  make({ pollInterval: Duration.seconds(15), polls: 60 }),
);
