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
export const tokenFailure = (error: OwnerMergeClient.OwnerMergeTokenError) => {
  switch (error._tag) {
    case "OwnerMergeTokenMissingError":
      return new KinExecError({ reason: "merge_token_missing", detail: error.message });
    case "OwnerMergePassStaleError":
      return new KinExecError({ reason: "credential_check_failed", detail: error.message });
    case "KinKeychainError":
      return new KinExecError({ reason: "unavailable", detail: "keychain unavailable" });
  }
};

/** The owner's token needs a hygiene pass; a GitHub kind run without one never writes. */
export const requirePass = (context: KinExecutionContext) =>
  Effect.fromOption(context.pass).pipe(
    Effect.mapError(
      () => new KinExecError({ reason: "credential_check_failed", detail: "no pass" }),
    ),
  );

export const githubUnavailable = (what: string) =>
  new KinExecError({ reason: "unavailable", detail: `could not read ${what} from GitHub` });

/**
 * Defence in depth: the signed payload must pin the very action and head the write will use.
 * Check 7 compared them at submission, and an approved action's record no longer changes.
 * Returns the signed head.
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
  return payload.headSha;
});
