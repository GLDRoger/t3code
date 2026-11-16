import { KinApprovalError, type KinApproverKeyPlatform } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PLATFORM: Record<KinApproverKeyPlatform, string> = {
  ios: "iPhone",
  android: "Android",
};

const isApprovalError = Schema.is(KinApprovalError);

/** The host's own words for a refusal, which name the fix; anything else is a plain retry. */
export function approvalsProblem(cause: unknown): { text: string; retry: boolean } {
  return isApprovalError(cause) && cause.reason !== "unavailable"
    ? { text: cause.message, retry: false }
    : { text: "Kin didn't answer. Try again.", retry: true };
}
