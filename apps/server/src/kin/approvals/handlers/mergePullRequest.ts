import type { KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { KinBotReads } from "../../github/KinBotReads.ts";
import { OwnerMergeClient } from "../../github/OwnerMergeClient.ts";
import { KinExecError, type KinActionHandler } from "../ActionHandlers.ts";
import { githubUnavailable, outcomeOf, requireBinding, tokenFailure } from "./ownerWrite.ts";

const partsOf = Effect.fnUntraced(function* (action: KinPendingAction) {
  if (
    action.kind !== "merge_pull_request" ||
    action.target._tag !== "pull_request" ||
    action.resolved._tag !== "pull_request"
  )
    return yield* new KinExecError({ reason: "invalid", detail: "not a pull request merge" });
  return { target: action.target, resolved: action.resolved };
});

/** Spec section 6, steps 4 and 5: precheck with the bot's token, merge with the owner's. */
export const makeMergePullRequestHandler = Effect.gen(function* () {
  const reads = yield* KinBotReads;
  const owner = yield* OwnerMergeClient;

  const precheck = Effect.fn("mergePullRequest.precheck")(function* (action: KinPendingAction) {
    const { target, resolved } = yield* partsOf(action);
    const pull = yield* reads
      .pullRequest({ repo: target.repo, number: target.number })
      .pipe(Effect.mapError(() => githubUnavailable("the pull request")));
    if (pull.merged || pull.state !== "open")
      return yield* new KinExecError({
        reason: "not_open",
        detail: pull.merged ? "merged" : "closed",
      });
    if (pull.headSha !== resolved.headSha)
      return yield* new KinExecError({ reason: "head_moved", detail: pull.headSha });
    if (pull.baseRef !== resolved.base)
      return yield* new KinExecError({ reason: "base_changed", detail: pull.baseRef });
    const queued = yield* reads
      .mergeQueueRequired({ repo: target.repo, branch: resolved.base })
      .pipe(Effect.mapError(() => githubUnavailable("the branch rules")));
    if (queued) return yield* new KinExecError({ reason: "merge_queue_unsupported" });
  });

  /**
   * `deleteBranchAfter`: only a same-repo head still at the merged SHA, and never one
   * `delete_branch` would refuse or that other work depends on. Never fails the merge.
   */
  const deleteHead = Effect.fn("mergePullRequest.deleteHead")(function* (
    action: KinPendingAction,
    pass: Parameters<OwnerMergeClient["Service"]["deleteBranch"]>[0],
  ) {
    const { target, resolved } = yield* partsOf(action);
    const branch = { repo: target.repo, branch: resolved.head };
    const pull = yield* reads.pullRequest({ repo: target.repo, number: target.number });
    if (pull.headRepo?.toLowerCase() !== target.repo.toLowerCase()) return "fork";
    if ((yield* reads.defaultBranch(target.repo)) === resolved.head) return "default branch";
    if (yield* reads.branchHasRules(branch)) return "branch rules apply";
    if (yield* reads.isBaseOfOpenPull(branch)) return "base of an open pull request";
    const head = yield* reads.branchHead(branch);
    if (Option.isNone(head) || head.value !== resolved.headSha) return "moved";
    const answer = yield* owner.deleteBranch(pass, branch);
    return answer._tag;
  });

  const run: KinActionHandler["run"] = Effect.fn("mergePullRequest.run")(
    function* (action, context) {
      const { target, resolved } = yield* partsOf(action);
      yield* requireBinding(action, context, resolved.headSha);
      const answer = yield* owner
        .merge(context.pass, {
          repo: target.repo,
          number: target.number,
          sha: resolved.headSha,
          mergeMethod: target.mergeMethod,
        })
        .pipe(Effect.mapError(tokenFailure));
      const outcome = yield* outcomeOf(answer);
      if (!target.deleteBranchAfter) return outcome;
      const deleted = yield* deleteHead(action, context.pass).pipe(
        Effect.orElseSucceed(() => "unavailable" as const),
      );
      if (deleted === "done") return outcome;
      yield* Effect.logInfo("Kin merge: head branch left in place", { reason: deleted });
      return { ...outcome, note: `Kept head branch ${resolved.head}: ${deleted}.` };
    },
  );

  const reconcile: KinActionHandler["reconcile"] = Effect.fn("mergePullRequest.reconcile")(
    function* (action) {
      const { target } = yield* partsOf(action);
      const pull = yield* reads
        .pullRequest({ repo: target.repo, number: target.number })
        .pipe(Effect.option);
      if (Option.isNone(pull)) return "unknown" as const;
      // `merged_by` isn't compared: only the owner's token can merge, and GitHub's own record wins.
      if (pull.value.merged && pull.value.mergeCommitSha !== null)
        return { _tag: "done", outcome: { mergeCommitSha: pull.value.mergeCommitSha } } as const;
      return pull.value.merged ? ("unknown" as const) : ("not_done" as const);
    },
  );

  return { kind: "merge_pull_request", precheck, run, reconcile } satisfies KinActionHandler;
});
