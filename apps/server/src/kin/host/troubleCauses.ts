import type {
  KinTroubleCause,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { setupFailure } from "../reply/classify.ts";

// ENOSPC and EDQUOT as Node reports them on Linux; an errno Node has no name for keeps only the number.
const SPACE_ERRNOS: ReadonlySet<unknown> = new Set([-28, -122]);
const SPACE_CODES: ReadonlySet<unknown> = new Set(["ENOSPC", "EDQUOT"]);
const NETWORK_CODES: ReadonlySet<unknown> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
// A provider's own text for a full disk, from the program it runs ("os error 28" is Rust's).
const SPACE_TEXT =
  /\bENOSPC\b|\bEDQUOT\b|no space left on device|disk quota exceeded|os error (?:28|122)\b/i;
const OVERLOADED = /^api_error_(?:5\d\d)$/;

const PROVIDER_CLASSES: ReadonlySet<unknown> = new Set([
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
const isProviderFailure = (value: object): value is OrchestrationV2ProviderFailure =>
  "class" in value &&
  PROVIDER_CLASSES.has(value.class) &&
  "message" in value &&
  typeof value.message === "string";

const ofProvider = (failure: OrchestrationV2ProviderFailure): KinTroubleCause | undefined => {
  if (SPACE_TEXT.test(failure.message)) return "space";
  const setup = setupFailure(failure);
  if (setup !== null) return setup;
  if (failure.class === "usage_limit") return "usage_limit";
  if (failure.class === "transport_error") return "unreachable";
  if (failure.code !== null && OVERLOADED.test(failure.code)) return "unreachable";
  return undefined;
};

/**
 * Why a wake-up failed, read from the failure's own chain: an Effect `Cause`, its fail and die
 * reasons, and their `cause` / `reason` / `error` fields, or a provider's failure. The first
 * cause found wins, except that a full disk anywhere wins over everything: it is what to fix.
 */
export function troubleCause(failure: unknown): KinTroubleCause {
  const seen = new Set<object>();
  let found: KinTroubleCause | undefined;
  const visit = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if (Cause.isCause(value))
      return value.reasons.some((reason) =>
        Cause.isFailReason(reason)
          ? visit(reason.error)
          : Cause.isDieReason(reason) && visit(reason.defect),
      );
    if ("errno" in value && SPACE_ERRNOS.has(value.errno)) return true;
    if ("code" in value && SPACE_CODES.has(value.code)) return true;
    if (isProviderFailure(value)) {
      const cause = ofProvider(value);
      if (cause === "space") return true;
      found ??= cause;
    }
    if ("code" in value && NETWORK_CODES.has(value.code)) found ??= "unreachable";
    return (
      ("cause" in value && visit(value.cause)) ||
      ("reason" in value && visit(value.reason)) ||
      ("error" in value && visit(value.error)) ||
      ("failure" in value && visit(value.failure))
    );
  };
  return visit(failure) ? "space" : (found ?? "unknown");
}

/** Causes Kin waits out with the turns held: they come back without anyone retyping anything. */
export const HELD_CAUSES: ReadonlySet<KinTroubleCause> = new Set([
  "space",
  "signin",
  "access",
  "model",
  "program",
  "usage_limit",
]);

/**
 * The failure that ended a run from `rootRunId` on, if one did: the last failed error item's.
 * A retry the provider recovered from leaves its error item `completed`: it ended nothing.
 */
export function providerFailureIn(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  rootRunId: RunId,
): OrchestrationV2ProviderFailure | null {
  const root = projection.runs.find((run) => run.id === rootRunId);
  if (root === undefined) return null;
  const runs = new Set(
    projection.runs.filter((run) => run.ordinal >= root.ordinal).map((run) => run.id),
  );
  let last: OrchestrationV2ProviderFailure | null = null;
  for (const item of projection.turnItems) {
    if (item.type !== "error" || item.status !== "failed") continue;
    if (item.runId === null || !runs.has(item.runId)) continue;
    last = item.failure;
  }
  return last;
}

/** When the provider said its usage limit resets, if it did. */
export const providerResetAt = (failure: unknown) =>
  typeof failure === "object" &&
  failure !== null &&
  isProviderFailure(failure) &&
  typeof failure.resetAt === "string"
    ? failure.resetAt
    : undefined;

const MAX_DETAIL = 300;
/** The failure's own short line, for a person to copy to whoever helps them. */
export function troubleDetail(failure: unknown): string | undefined {
  const seen = new Set<object>();
  const find = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.trim() === "" ? undefined : value;
    if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
    seen.add(value);
    if (Cause.isCause(value)) {
      for (const reason of value.reasons) {
        const line = Cause.isFailReason(reason)
          ? find(reason.error)
          : Cause.isDieReason(reason)
            ? find(reason.defect)
            : undefined;
        if (line !== undefined) return line;
      }
      return undefined;
    }
    const tag = "_tag" in value && typeof value._tag === "string" ? value._tag : undefined;
    const message =
      "message" in value && typeof value.message === "string" && value.message.trim() !== ""
        ? value.message
        : undefined;
    const inner =
      ("cause" in value ? find(value.cause) : undefined) ??
      ("error" in value ? find(value.error) : undefined);
    const own = message ?? tag;
    if (own === undefined) return inner;
    return inner === undefined || own.includes(inner) ? own : `${own}: ${inner}`;
  };
  const line = find(failure)?.split("\n")[0]?.trim();
  if (line === undefined || line === "") return undefined;
  return line.length <= MAX_DETAIL ? line : `${line.slice(0, MAX_DETAIL - 1)}…`;
}
