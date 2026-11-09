import type { KinGrantPayload, KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as OwnerMergeClient from "../../github/OwnerMergeClient.ts";
import { KinExecError, type KinExecutionContext, type KinOutcome } from "../ActionHandlers.ts";

/** Maps GitHub's answer to an owner write; `unknown` means it may have landed. */
export const outcomeOf = (
  answer: OwnerMergeClient.OwnerWriteAnswer,
): Effect.Effect<KinOutcome, KinExecError> => {
  const requestId = answer.requestId === undefined ? {} : { githubRequestId: answer.requestId };
  switch (answer._tag) {
    case "done":
      return Effect.succeed({
        ...requestId,
        ...(answer.mergeCommitSha === undefined ? {} : { mergeCommitSha: answer.mergeCommitSha }),
      });
    case "refused":
      return Effect.fail(
        new KinExecError({
          reason: answer.reason,
          detail: `HTTP ${answer.status}${answer.message === "" ? "" : ` ${answer.message}`}`,
          ...requestId,
        }),
      );
    case "unknown":
      return Effect.fail(
        new KinExecError({
          reason: "unknown_outcome",
          detail: answer.status === undefined ? "no answer" : `HTTP ${answer.status}`,
          ...requestId,
        }),
      );
  }
};

/** Token reads fail before anything is sent, so they are definite failures. */
export const tokenFailure = (
  error: OwnerMergeClient.OwnerMergeTokenMissingError | { readonly _tag: "KinKeychainError" },
) =>
  new KinExecError({
    reason: error._tag === "OwnerMergeTokenMissingError" ? "merge_token_missing" : "unavailable",
    detail: error._tag === "OwnerMergeTokenMissingError" ? error.message : "keychain unavailable",
  });

export const githubUnavailable = (what: string) =>
  new KinExecError({ reason: "unavailable", detail: `could not read ${what} from GitHub` });

/**
 * Defence in depth: the signed payload must pin the very action and head the write will use.
 * Check 7 compared them at submission, and an approved action's record no longer changes.
 */
export const requireBinding = Effect.fn("KinExecutor.requireBinding")(function* (
  action: KinPendingAction,
  context: KinExecutionContext,
  headSha: string,
) {
  const payload: KinGrantPayload = yield* context.payload;
  if (
    payload.orgId !== action.orgId ||
    payload.actionId !== action.id ||
    payload.revision !== action.revision ||
    payload.kind !== action.kind ||
    payload.targetDigest !== action.targetDigest ||
    payload.headSha !== headSha ||
    context.grant.actionId !== action.id ||
    context.grant.revision !== action.revision
  )
    return yield* new KinExecError({
      reason: "grant_mismatch",
      detail: "the grant doesn't bind this action",
    });
});
