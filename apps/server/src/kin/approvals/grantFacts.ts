import type { KinActionKind, KinGrantPayload, KinPendingAction } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

export const pinsHead = (kind: KinActionKind) =>
  kind === "merge_pull_request" || kind === "delete_branch";

/** The facts a grant must copy from the server's record (check 7), absent ones dropped. */
export const recordFacts = (action: KinPendingAction) => ({
  kind: action.kind,
  target: action.target,
  targetDigest: action.targetDigest,
  headSha:
    pinsHead(action.kind) && action.resolved._tag !== "none" ? action.resolved.headSha : undefined,
  base:
    action.kind === "merge_pull_request" && action.resolved._tag === "pull_request"
      ? action.resolved.base
      : undefined,
  mergeMethod: action.target._tag === "pull_request" ? action.target.mergeMethod : undefined,
});

const grantFacts = (payload: KinGrantPayload) => ({
  kind: payload.kind,
  target: payload.target,
  targetDigest: payload.targetDigest,
  headSha: payload.headSha,
  base: payload.base,
  mergeMethod: payload.mergeMethod,
});

/** Check 7: what was signed is what the server recorded. */
export const grantMatchesRecord = (payload: KinGrantPayload, action: KinPendingAction) =>
  stableStringify(grantFacts(payload)) === stableStringify(recordFacts(action));
