import type { KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { KinBotReads } from "../../github/KinBotReads.ts";
import { OwnerMergeClient } from "../../github/OwnerMergeClient.ts";
import { KinExecError, type KinActionHandler } from "../ActionHandlers.ts";
import {
  githubUnavailable,
  outcomeOf,
  requireBinding,
  requirePass,
  tokenFailure,
} from "./ownerWrite.ts";

const partsOf = Effect.fnUntraced(function* (action: KinPendingAction) {
  if (
    action.kind !== "delete_branch" ||
    action.target._tag !== "branch" ||
    action.resolved._tag !== "branch"
  )
    return yield* new KinExecError({ reason: "invalid", detail: "not a branch deletion" });
  return { target: action.target, resolved: action.resolved };
});

/**
 * GitHub's ref delete takes no expected SHA, so the precheck right before it is the only pin: a
 * push landing between the two is deleted with the branch (spec section 6).
 */
export const makeDeleteBranchHandler = Effect.gen(function* () {
  const reads = yield* KinBotReads;
  const owner = yield* OwnerMergeClient;

  const head = (action: KinPendingAction) =>
    partsOf(action).pipe(
      Effect.flatMap(({ target }) =>
        reads
          .branchHead({ repo: target.repo, branch: target.ref })
          .pipe(Effect.mapError(() => githubUnavailable("the branch"))),
      ),
    );

  const precheck = Effect.fn("deleteBranch.precheck")(function* (action: KinPendingAction) {
    const { target, resolved } = yield* partsOf(action);
    const defaultBranch = yield* reads
      .defaultBranch(target.repo)
      .pipe(Effect.mapError(() => githubUnavailable("the repository")));
    if (defaultBranch === target.ref)
      return yield* new KinExecError({ reason: "refused", detail: "the default branch" });
    const current = yield* head(action);
    if (Option.isNone(current)) return yield* new KinExecError({ reason: "not_found" });
    if (current.value !== resolved.headSha)
      return yield* new KinExecError({ reason: "head_moved", detail: current.value });
  });

  const run: KinActionHandler["run"] = Effect.fn("deleteBranch.run")(function* (action, context) {
    const { target, resolved } = yield* partsOf(action);
    yield* requireBinding(action, context, resolved.headSha);
    const pass = yield* requirePass(context);
    const answer = yield* owner
      .deleteBranch(pass, { repo: target.repo, branch: target.ref })
      .pipe(Effect.mapError(tokenFailure));
    return yield* outcomeOf(answer);
  });

  const reconcile: KinActionHandler["reconcile"] = Effect.fn("deleteBranch.reconcile")(
    function* (action) {
      const current = yield* head(action).pipe(Effect.option);
      if (Option.isNone(current)) return "unknown" as const;
      return Option.isNone(current.value) ? ("done" as const) : ("not_done" as const);
    },
  );

  return {
    kind: "delete_branch",
    credentialCheck: true,
    precheck,
    run,
    reconcile,
  } satisfies KinActionHandler;
});
