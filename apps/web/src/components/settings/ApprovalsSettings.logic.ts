import {
  KinApprovalError,
  type KinApprovalsListKeysResult,
  type KinKeyThumbprint,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export type ApprovalPhone = {
  readonly thumbprint: KinKeyThumbprint;
  /** As the phone reported it. */
  readonly name: string;
  readonly kind: string;
  readonly askedAt: number;
};
export type WaitingPhone = ApprovalPhone & {
  readonly matchCode: string;
  readonly expiresAt: number;
};
export type AllowedPhone = ApprovalPhone & { readonly allowedAt: number | null };

const KIND: Record<string, string> = { ios: "iOS", android: "Android" };
// A request nobody answered stays listed for a day so the owner sees it happened.
const EXPIRED_SHOWN_MS = 24 * 60 * 60 * 1000;

/** Waiting requests, then phones that approve, then requests that ran out. Revoked keys are gone. */
export function approvalPhones(result: KinApprovalsListKeysResult, now: number) {
  const requests = new Map((result.requests ?? []).map((request) => [request.thumbprint, request]));
  const waiting: Array<WaitingPhone> = [];
  const allowed: Array<AllowedPhone> = [];
  const expired: Array<ApprovalPhone> = [];
  for (const key of result.keys) {
    const phone: ApprovalPhone = {
      thumbprint: key.thumbprint,
      name: key.deviceLabel,
      kind: KIND[key.platform] ?? "Phone",
      askedAt: DateTime.toEpochMillis(key.createdAt),
    };
    if (key.state === "active") {
      allowed.push({
        ...phone,
        allowedAt: key.confirmedAt === undefined ? null : DateTime.toEpochMillis(key.confirmedAt),
      });
      continue;
    }
    // An unattested key can never be allowed, and the phone already says so.
    if (key.state !== "pending" || !key.attested) continue;
    const request = requests.get(key.thumbprint);
    const expiresAt = request === undefined ? 0 : DateTime.toEpochMillis(request.expiresAt);
    if (request !== undefined && expiresAt > now)
      waiting.push({ ...phone, matchCode: request.matchCode, expiresAt });
    else if (now - phone.askedAt < EXPIRED_SHOWN_MS) expired.push(phone);
  }
  return { waiting, allowed, expired };
}

const isApprovalError = Schema.is(KinApprovalError);

/** The host's own words for a refusal; they name the fix. Anything else is a plain retry. */
export function approvalsProblem(cause: unknown): string {
  return isApprovalError(cause) && cause.reason !== "unavailable"
    ? cause.message
    : "Kin didn't answer. Try again.";
}

/** `482 913`, read in two halves like the phone shows it. */
export const spacedMatchCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
