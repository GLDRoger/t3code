import { KinApprovalError, type KinApproverKeyPlatform } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PLATFORM: Record<KinApproverKeyPlatform, string> = {
  ios: "iPhone",
  android: "Android",
};

const isApprovalError = Schema.is(KinApprovalError);

/** The host's own words for a refusal; they name the fix. Anything else is a plain retry. */
export function approvalsProblem(cause: unknown): string {
  return isApprovalError(cause) && cause.reason !== "unavailable"
    ? cause.message
    : "Kin didn't answer. Try again.";
}
