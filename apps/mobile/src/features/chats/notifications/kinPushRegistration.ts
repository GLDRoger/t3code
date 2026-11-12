import { KinPushError, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isKinPushError = Schema.is(KinPushError);

interface KinPushTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  /** The person this session is in that org; a refusal holds only for them. */
  readonly personId: string;
  readonly token: string;
}

const targetKey = (target: KinPushTarget) =>
  `${target.environmentId}\u0000${target.orgId}\u0000${target.personId}\u0000${target.token}`;

/**
 * Tokens a host holds for another person. That answer is final for this person: the token isn't
 * sent to that org again until it or the signed-in person changes, and each refusal is noted once.
 */
export function createKinPushRefusals() {
  const refused = new Set<string>();
  return {
    isRefused: (target: KinPushTarget) => refused.has(targetKey(target)),
    /** True the first time `error` refuses `target` for good. */
    note: (target: KinPushTarget, error: unknown): boolean => {
      if (!isKinPushError(error) || error.reason !== "registered_to_someone_else") return false;
      const key = targetKey(target);
      if (refused.has(key)) return false;
      refused.add(key);
      return true;
    },
  };
}

/**
 * What push registration does with the OS permission. Connecting never prompts: the prompt waits
 * for a Kin moment that explains it (opening a chat, the Kin notifications row) and shows once.
 */
export function kinPushPermissionStep(
  permission: { readonly granted: boolean; readonly canAskAgain: boolean },
  request: { readonly wanted: boolean; readonly asked: boolean },
): "register" | "ask" | "wait" {
  if (permission.granted) return "register";
  return request.wanted && !request.asked && permission.canAskAgain ? "ask" : "wait";
}
