import { Sha40, type RepoSlug } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { gitHubAnswer, KinGitHubRequestError, repoPath } from "./githubRest.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";

// Read-only, so the executor's prechecks never hold a token that could write.
const READ_PERMISSIONS = { pull_requests: "read", contents: "read" } as const;

const PullAnswer = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  merge_commit_sha: Schema.NullOr(Schema.String),
  head: Schema.Struct({
    sha: Sha40,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
});
const decodePull = Schema.decodeUnknownOption(PullAnswer);
const RefAnswer = Schema.Struct({ object: Schema.Struct({ sha: Sha40 }) });
const decodeRef = Schema.decodeUnknownOption(RefAnswer);
const RulesAnswer = Schema.Array(Schema.Struct({ type: Schema.String }));
const decodeRules = Schema.decodeUnknownOption(RulesAnswer);
const OpenPullsAnswer = Schema.Array(Schema.Struct({ number: Schema.Int }));
const decodeOpenPulls = Schema.decodeUnknownOption(OpenPullsAnswer);
const RepoAnswer = Schema.Struct({ default_branch: Schema.String });
const decodeRepo = Schema.decodeUnknownOption(RepoAnswer);

export interface KinPullRequestState {
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly headSha: string;
  readonly headRef: string;
  /** `owner/name` of the head branch's repository; null when that fork was deleted. */
  readonly headRepo: string | null;
  readonly baseRef: string;
}

export type KinBotReadError = KinGitHubApp.KinGitHubAppError;

const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/**
 * The executor's live reads with the bot App's `server` token (spec section 6, precheck and
 * reconcile). Any failure means "can't tell", never "not merged".
 */
export class KinBotReads extends Context.Service<
  KinBotReads,
  {
    readonly pullRequest: (input: {
      readonly repo: RepoSlug;
      readonly number: number;
    }) => Effect.Effect<KinPullRequestState, KinBotReadError>;
    /** The branch's head, or none when GitHub has no such branch. */
    readonly branchHead: (input: {
      readonly repo: RepoSlug;
      readonly branch: string;
    }) => Effect.Effect<Option.Option<string>, KinBotReadError>;
    readonly defaultBranch: (repo: RepoSlug) => Effect.Effect<string, KinBotReadError>;
    /** Phase 1 refuses merge-queue branches (`merge_queue_unsupported`). */
    readonly mergeQueueRequired: (input: {
      readonly repo: RepoSlug;
      readonly branch: string;
    }) => Effect.Effect<boolean, KinBotReadError>;
    /** Whether any ruleset rule applies to the branch. */
    readonly branchHasRules: (input: {
      readonly repo: RepoSlug;
      readonly branch: string;
    }) => Effect.Effect<boolean, KinBotReadError>;
    /** Whether an open pull request targets the branch as its base. */
    readonly isBaseOfOpenPull: (input: {
      readonly repo: RepoSlug;
      readonly branch: string;
    }) => Effect.Effect<boolean, KinBotReadError>;
  }
>()("t3/kin/github/KinBotReads") {}

const make = Effect.gen(function* () {
  const app = yield* KinGitHubApp.KinGitHubApp;
  const client = yield* HttpClient.HttpClient;

  const read = Effect.fnUntraced(function* <A>(
    repo: RepoSlug,
    operation: string,
    path: string,
    decode: (body: unknown) => Option.Option<A>,
    missingOk: boolean,
  ) {
    const { token } = yield* app.installationToken({
      repo,
      permissions: READ_PERMISSIONS,
      holder: "server",
    });
    const answer = yield* gitHubAnswer({ client, operation, method: "GET", path, token });
    if (missingOk && answer.status === 404) return Option.none<A>();
    const fail = (stage: "status" | "decode") =>
      new KinGitHubRequestError({ operation, stage, status: answer.status });
    if (answer.status !== 200) return yield* fail("status");
    const body = decode(answer.body);
    if (Option.isNone(body)) return yield* fail("decode");
    return body;
  });

  const required = <A>(effect: Effect.Effect<Option.Option<A>, KinBotReadError>) =>
    effect.pipe(Effect.map(Option.getOrThrow));

  // Active rules on the branch from every ruleset that targets it.
  const branchRules = (repo: RepoSlug, branch: string) =>
    required(
      read(
        repo,
        "repos.getBranchRules",
        `${repoPath(repo)}/rules/branches/${branchPath(branch)}`,
        decodeRules,
        false,
      ),
    );

  return KinBotReads.of({
    pullRequest: Effect.fn("KinBotReads.pullRequest")(function* ({ repo, number }) {
      const pull = yield* required(
        read(repo, "pulls.get", `${repoPath(repo)}/pulls/${number}`, decodePull, false),
      );
      return {
        state: pull.state,
        merged: pull.merged,
        mergeCommitSha: pull.merge_commit_sha,
        headSha: pull.head.sha,
        headRef: pull.head.ref,
        headRepo: pull.head.repo?.full_name ?? null,
        baseRef: pull.base.ref,
      } satisfies KinPullRequestState;
    }),
    branchHead: Effect.fn("KinBotReads.branchHead")(function* ({ repo, branch }) {
      const ref = yield* read(
        repo,
        "git.getRef",
        `${repoPath(repo)}/git/ref/heads/${branchPath(branch)}`,
        decodeRef,
        true,
      );
      return Option.map(ref, (found) => found.object.sha);
    }),
    defaultBranch: Effect.fn("KinBotReads.defaultBranch")(function* (repo) {
      const found = yield* required(read(repo, "repos.get", repoPath(repo), decodeRepo, false));
      return found.default_branch;
    }),
    mergeQueueRequired: Effect.fn("KinBotReads.mergeQueueRequired")(function* ({ repo, branch }) {
      const rules = yield* branchRules(repo, branch);
      return rules.some((rule) => rule.type === "merge_queue");
    }),
    branchHasRules: Effect.fn("KinBotReads.branchHasRules")(function* ({ repo, branch }) {
      return (yield* branchRules(repo, branch)).length > 0;
    }),
    isBaseOfOpenPull: Effect.fn("KinBotReads.isBaseOfOpenPull")(function* ({ repo, branch }) {
      const pulls = yield* required(
        read(
          repo,
          "pulls.list",
          `${repoPath(repo)}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=1`,
          decodeOpenPulls,
          false,
        ),
      );
      return pulls.length > 0;
    }),
  });
});

export const layer = Layer.effect(KinBotReads, make);
