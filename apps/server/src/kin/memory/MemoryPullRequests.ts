import type { KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type ApiAnswer, type ApiRequest, KinGitHubApi } from "../github/GitHubWatch.ts";
import { gitHubApp } from "../github/KinGitHubApp.ts";
import { WRITE_BRANCH_PREFIX } from "./MemoryConfig.ts";

// GitHub Actions' app id: a `memory-check` run from any other app doesn't count.
const GITHUB_ACTIONS_INTEGRATION_ID = 15368;
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
      head_repository: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
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
const decodeEvents = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ event: Schema.String })),
);

export class MemoryPullRequestRefused extends Schema.TaggedError<MemoryPullRequestRefused>()(
  "MemoryPullRequestRefused",
  {
    orgId: Schema.String,
    // Built from fixed text, GitHub's status and error message; never a token.
    reason: Schema.String,
    url: Schema.optional(Schema.String),
    /** GitHub merges it only after a review, which only the owner can give. */
    waitsOnOwner: Schema.optional(Schema.Boolean),
  },
) {}

type MemoryPullRequestOutcome =
  | { readonly _tag: "merged"; readonly url: string; readonly commit: string }
  /** A guard-rails PR GitHub won't merge yet; it stays open with the head Kin pushed. */
  | {
      readonly _tag: "held";
      readonly url: string;
      readonly reason: string;
      readonly waitsOnOwner: boolean;
    }
  /** The guard-rails PR from this branch was closed without merging; Kin opens no other from it. */
  | { readonly _tag: "closed"; readonly url: string };

interface MemoryPullRequestInput {
  readonly orgId: KinOrgId;
  readonly repo: RepoSlug;
  readonly branch: string;
  readonly base: string;
  /** The commit Kin pushed to `branch`; nothing else is ever merged. */
  readonly sha: string;
  readonly title: string;
  readonly message: string;
  /**
   * `batch` is one landing attempt, closed on any refusal. `guard-rails` is the one PR that brings
   * the repo's guard rails up to date: only the owner may approve it, so it stays open, its head
   * untouched (a push would dismiss his approval), and every landing run tries to merge it again.
   */
  readonly kind: "batch" | "guard-rails";
}

export interface OpenMemoryPullRequest {
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly head: string;
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
    /**
     * Open PRs from `kin/write/*` branches, newest first, over up to ten pages of open PRs;
     * `complete` is false when more were left unread.
     */
    readonly openPulls: (input: {
      readonly orgId: KinOrgId;
      readonly repo: RepoSlug;
    }) => Effect.Effect<
      { readonly pulls: ReadonlyArray<OpenMemoryPullRequest>; readonly complete: boolean },
      MemoryPullRequestRefused
    >;
    /** Closes one of Kin's memory PRs with a one-line comment giving the reason. */
    readonly close: (input: {
      readonly orgId: KinOrgId;
      readonly repo: RepoSlug;
      readonly number: number;
      readonly reason: string;
    }) => Effect.Effect<void, MemoryPullRequestRefused>;
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

/**
 * A `pull_request` run of the memory-check workflow on this branch and commit. GitHub fills
 * `pull_requests` from the PRs open with that head now, not the one that triggered the run, so
 * `land` also checks that no other PR ever came from this branch and that this PR's base never
 * changed.
 */
const isOurRun = (
  input: MemoryPullRequestInput,
  number: number,
  run: (typeof WorkflowRuns.Type)["workflow_runs"][number],
) =>
  run.path === MEMORY_CHECK_WORKFLOW &&
  run.event === "pull_request" &&
  run.head_sha === input.sha &&
  run.head_branch === input.branch &&
  run.head_repository?.full_name === input.repo &&
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
const MAX_OPEN_PAGES = 10;
const MAX_RUNS = 10;
// Every call runs under the landing lock; GitHub's own edge gives up after about 10 seconds.
const CALL_TIMEOUT: Duration.Input = "30 seconds";

interface GitHubAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** GitHub's `message`, or "" when the body has none. Error messages carry no credential. */
  readonly message: string;
  readonly body: unknown;
}
const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);
const answerOf = (answer: ApiAnswer): GitHubAnswer => ({
  status: answer.status,
  headers: answer.headers,
  message: Option.match(decodeErrorMessage(answer.body), {
    onNone: () => "",
    onSome: ({ message }) => message,
  }),
  body: answer.body,
});
/** `memory-check.yml`'s job timeout: past it the check can't pass. */
const CHECK_DEADLINE: Duration.Input = "15 minutes";

/** A full page, or a `next` link, may hide more; lists that decide anything fail closed on it. */
const pastOnePage = (answer: GitHubAnswer, length: number) =>
  length >= PAGE || /rel="next"/.test(answer.headers["link"] ?? "");

/** GitHub's answer to a merge that a required review still blocks: only the owner can clear it. */
const waitsOnReview = (answer: { status: number; message: string }) =>
  answer.status === 405 && /review/i.test(answer.message);

export const make = Effect.fn("MemoryPullRequests.make")(function* (options: {
  readonly pollInterval: Duration.Input;
}) {
  const api = yield* KinGitHubApi;
  const app = yield* gitHubApp;

  const connect = Effect.fn("MemoryPullRequests.connect")(function* (
    orgId: KinOrgId,
    repo: RepoSlug,
  ) {
    const refuse = (reason: string, url?: string, waitsOnOwner?: boolean) =>
      new MemoryPullRequestRefused({
        orgId,
        reason,
        ...(url === undefined ? {} : { url }),
        ...(waitsOnOwner === true ? { waitsOnOwner } : {}),
      });
    // As Kin's GitHub App where it is installed on the memory repo, else as the owner.
    const asApp = Effect.fn("MemoryPullRequests.asApp")(function* () {
      return Option.isSome(app) ? yield* app.value.on(repo) : undefined;
    });
    if ((yield* asApp()) === undefined && (yield* api.connected()) === null)
      return yield* refuse(
        "neither Kin's GitHub App nor the owner's GitHub login reaches this repo",
      );
    const send = (request: ApiRequest, as: "default" | "owner") =>
      as === "owner"
        ? api.call(request)
        : asApp().pipe(Effect.flatMap((viaApp) => (viaApp?.call ?? api.call)(request)));
    const [owner = "", name = ""] = repo.split("/");
    const base = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const fromBranch = (branch: string) => encodeURIComponent(`${owner}:${branch}`);
    const call = (
      operation: string,
      method: "GET" | "POST" | "PUT" | "PATCH",
      path: string,
      body?: unknown,
      as: "default" | "owner" = "default",
    ) =>
      send({ method, path: `${base}${path}`, ...(body === undefined ? {} : { body }) }, as).pipe(
        Effect.timeout(CALL_TIMEOUT),
        Effect.flatMap((answer) =>
          answer.status === 0 ? Effect.fail(undefined) : Effect.succeed(answerOf(answer)),
        ),
        Effect.mapError(() => refuse(`could not reach GitHub for ${operation}`)),
      );
    const close = Effect.fn("MemoryPullRequests.close")(function* (number: number, reason: string) {
      const closed = yield* call("pulls.close", "PATCH", `/pulls/${number}`, { state: "closed" });
      if (closed.status !== 200) return yield* refuse(`GitHub did not close PR #${number}`);
      yield* call("issues.comment", "POST", `/issues/${number}/comments`, {
        body: `Kin closed this memory PR: ${reason}.`,
      }).pipe(Effect.ignore);
    });
    // The owner's login merges what the App may not, such as a change to a workflow file.
    const ownerConnected = Effect.gen(function* () {
      return (yield* asApp()) !== undefined && (yield* api.connected()) !== null;
    });
    return { refuse, call, close, fromBranch, ownerConnected };
  });

  const land = Effect.fn("MemoryPullRequests.land")(function* (input: MemoryPullRequestInput) {
    yield* Effect.annotateCurrentSpan({
      "kin.github.repo": input.repo,
      "kin.memory.pr": input.kind,
    });
    const { refuse, call, close, fromBranch, ownerConnected } = yield* connect(
      input.orgId,
      input.repo,
    );
    const guardRails = input.kind === "guard-rails";
    const describe = (answer: { status: number; message: string }) =>
      `HTTP ${answer.status}${answer.message ? `: ${answer.message}` : ""}`;
    const openFromBranch = call(
      "pulls.list",
      "GET",
      `/pulls?state=open&head=${fromBranch(input.branch)}&base=${encodeURIComponent(input.base)}`,
    ).pipe(Effect.map((listed) => Option.getOrUndefined(decodePulls(listed.body))?.[0]));

    // The guard-rails PR is opened once and found again on every later run.
    let pull = guardRails ? yield* openFromBranch : undefined;
    if (guardRails && pull === undefined) {
      const listed = yield* call(
        "pulls.list",
        "GET",
        `/pulls?state=all&head=${fromBranch(input.branch)}&per_page=${PAGE}`,
      );
      const earlier = Option.getOrUndefined(decodePulls(listed.body))?.[0];
      if (earlier !== undefined) return { _tag: "closed", url: earlier.html_url } as const;
    }
    if (pull === undefined) {
      const opened = yield* call("pulls.create", "POST", "/pulls", {
        title: input.title,
        head: input.branch,
        base: input.base,
        body: guardRails
          ? `Kin's memory repo guard rails, as its server now ships them: \`.github/CODEOWNERS\` and \`.github/workflows/memory-check.yml\`, nothing else. Kin pushed \`${input.sha}\` and merges this itself once you approve it and \`${MEMORY_CHECK_NAME}\` passes. It never pushes to this branch again, so your approval stays; if the head differs, close it.`
          : `Kin merges this once \`${MEMORY_CHECK_NAME}\` passes on the commit it pushed.`,
        maintainer_can_modify: false,
      });
      pull = opened.status === 201 ? Option.getOrUndefined(decodePull(opened.body)) : undefined;
      // A retry of the same write finds the PR it opened before.
      if (pull === undefined && opened.status === 422) pull = yield* openFromBranch;
      if (pull === undefined) return yield* refuse(`GitHub refused the PR (${describe(opened)})`);
    }
    const { number, html_url: url } = pull;

    const refuseAndClose = (reason: string, waitsOnOwner?: boolean) =>
      close(number, reason).pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not close a refused memory PR", { repo: input.repo, number }),
        ),
        Effect.andThen(Effect.fail(refuse(reason, url, waitsOnOwner))),
      );
    // A batch PR is closed on any refusal; the guard-rails PR waits, open, for what can change it.
    const hold = (reason: string, waitsOnOwner = false) =>
      guardRails
        ? Effect.succeed({ _tag: "held", url, reason, waitsOnOwner } as const)
        : refuseAndClose(reason, waitsOnOwner);

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
    // Ties every run on Kin's branch to this PR into `input.base`: an agent could open another PR
    // from the branch into a base with its own `memory-check.yml`, or move this PR's base there.
    const unboundReason = Effect.gen(function* () {
      const listed = yield* call(
        "pulls.list",
        "GET",
        `/pulls?state=all&head=${fromBranch(input.branch)}&per_page=${PAGE}`,
      );
      const pulls = listed.status === 200 ? decodePulls(listed.body) : Option.none();
      if (Option.isNone(pulls)) return "GitHub did not list the PRs from Kin's branch";
      if (pastOnePage(listed, pulls.value.length))
        return "GitHub listed more PRs from Kin's branch than one page holds";
      if (pulls.value.length !== 1 || pulls.value[0]?.number !== number)
        return "another PR was opened from Kin's branch";
      const answer = yield* call(
        "issues.events",
        "GET",
        `/issues/${number}/events?per_page=${PAGE}`,
      );
      const events = answer.status === 200 ? decodeEvents(answer.body) : Option.none();
      if (Option.isNone(events)) return "GitHub did not list the PR's events";
      if (pastOnePage(answer, events.value.length))
        return "GitHub listed more PR events than one page holds";
      if (events.value.some((event) => event.event === "base_ref_changed"))
        return "the PR's base branch was changed";
      return undefined;
    });
    const refuseUnbound = Effect.gen(function* () {
      const reason = yield* unboundReason;
      if (reason !== undefined) return yield* refuseAndClose(reason);
    });

    if (!(yield* headIsOurs))
      return yield* refuseAndClose("the PR's head is not the commit Kin pushed");
    yield* refuseUnbound;

    const awaitCheck = Effect.gen(function* () {
      let verdict: Verdict = { _tag: "pending" };
      for (let poll = 0; verdict._tag === "pending"; poll++) {
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
            Effect.map((answer) =>
              answer.status === 200 ? decodeJobs(answer.body) : Option.none(),
            ),
          ),
        );
        if (jobs.some(Option.isNone)) continue;
        verdict = memoryCheckVerdict(input.sha, decodedChecks.value, jobs.flatMap(Option.toArray));
      }
      return verdict;
    });
    // The landing lock is held while this waits, so the deadline bounds slow calls too.
    const verdict = Option.getOrElse(
      yield* awaitCheck.pipe(Effect.timeoutOption(CHECK_DEADLINE)),
      (): Verdict => ({ _tag: "pending" }),
    );
    if (verdict._tag === "pending")
      return yield* hold(`${MEMORY_CHECK_NAME} did not finish in time`);
    // A foreign check is someone else's work on Kin's commit: never kept open.
    if (verdict._tag === "fail")
      return yield* verdict.reason === `${MEMORY_CHECK_NAME} failed`
        ? hold(verdict.reason)
        : refuseAndClose(verdict.reason);
    if (!(yield* headIsOurs))
      return yield* refuseAndClose("the PR's head moved after the check passed");
    yield* refuseUnbound;

    const [title, ...rest] = input.message.split("\n");
    const mergeAs = (as: "default" | "owner") =>
      call(
        "pulls.merge",
        "PUT",
        `/pulls/${number}/merge`,
        {
          merge_method: "squash",
          sha: input.sha,
          commit_title: title,
          commit_message: rest.join("\n").trim(),
        },
        as,
      );
    let merge = yield* mergeAs("default");
    if (guardRails && merge.status !== 200 && !waitsOnReview(merge) && (yield* ownerConnected))
      merge = yield* mergeAs("owner");
    const merged = merge.status === 200 ? decodeMerge(merge.body) : Option.none();
    if (Option.isSome(merged) && merged.value.merged)
      return { _tag: "merged", url, commit: merged.value.sha } as const;
    return yield* hold(`GitHub refused the merge (${describe(merge)})`, waitsOnReview(merge));
  });

  const openPulls = Effect.fn("MemoryPullRequests.openPulls")(function* (input: {
    readonly orgId: KinOrgId;
    readonly repo: RepoSlug;
  }) {
    yield* Effect.annotateCurrentSpan({ "kin.github.repo": input.repo });
    const { refuse, call } = yield* connect(input.orgId, input.repo);
    const all: Array<typeof Pull.Type> = [];
    let complete = false;
    for (let page = 1; page <= MAX_OPEN_PAGES && !complete; page++) {
      const listed = yield* call(
        "pulls.list",
        "GET",
        `/pulls?state=open&per_page=${PAGE}&page=${page}`,
      );
      const pulls = listed.status === 200 ? decodePulls(listed.body) : Option.none();
      if (Option.isNone(pulls)) return yield* refuse("GitHub did not list the open PRs");
      all.push(...pulls.value);
      complete = !pastOnePage(listed, pulls.value.length);
    }
    if (!complete)
      yield* Effect.logWarning("More open PRs than one memory PR sweep reads", {
        repo: input.repo,
      });
    const pulls = all
      .filter(
        (pull) =>
          pull.head.ref.startsWith(WRITE_BRANCH_PREFIX) &&
          pull.head.repo?.full_name.toLowerCase() === input.repo.toLowerCase(),
      )
      .map((pull) => ({
        number: pull.number,
        url: pull.html_url,
        branch: pull.head.ref,
        head: pull.head.sha,
      }));
    return { pulls, complete };
  });

  const close = Effect.fn("MemoryPullRequests.closeOne")(function* (input: {
    readonly orgId: KinOrgId;
    readonly repo: RepoSlug;
    readonly number: number;
    readonly reason: string;
  }) {
    yield* Effect.annotateCurrentSpan({ "kin.github.repo": input.repo });
    const connected = yield* connect(input.orgId, input.repo);
    yield* connected.close(input.number, input.reason);
  });

  return MemoryPullRequests.of({ land, openPulls, close });
});

/** Polls `memory-check` every 15 seconds until the job's 15-minute timeout. */
export const layer = Layer.effect(MemoryPullRequests, make({ pollInterval: Duration.seconds(15) }));
