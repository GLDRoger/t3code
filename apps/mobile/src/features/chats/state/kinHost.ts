import {
  EnvironmentAuthorizationError,
  KinChatError,
  type EnvironmentId,
  type KinOrgsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

/** What one connected environment's `kin.orgs.list` says about Kin there. */
export type KinProbe =
  | { readonly _tag: "pending" }
  | { readonly _tag: "ready"; readonly orgs: KinOrgsListResult }
  /** A Kin host that maps this session to no person. */
  | { readonly _tag: "noIdentity"; readonly orgs: KinOrgsListResult }
  | { readonly _tag: "unauthorized"; readonly message: string }
  /** `transient` for transport failures and timeouts: the host may still be Kin. */
  | { readonly _tag: "error"; readonly message: string; readonly transient: boolean }
  /** A plain T3 server, or Kin turned off, misconfigured or failed at startup (`disabled`). */
  | { readonly _tag: "notKin" };

const isKinChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const defectMessage = (defect: unknown) =>
  typeof defect === "string" ? defect : defect instanceof Error ? defect.message : "";

export function classifyKinProbe(
  result: AsyncResult.AsyncResult<KinOrgsListResult, unknown>,
): KinProbe {
  if (result._tag === "Success") {
    return result.value.me.length === 0
      ? { _tag: "noIdentity", orgs: result.value }
      : { _tag: "ready", orgs: result.value };
  }
  if (result._tag === "Initial") return { _tag: "pending" };
  const failures = result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
  for (const error of failures) {
    if (isAuthorizationError(error)) return { _tag: "unauthorized", message: error.message };
    if (isKinChatError(error)) {
      if (error.reason === "disabled") return { _tag: "notKin" };
      // Known hosts retry `unavailable`; a host never seen as Kin gets here with it.
      return { _tag: "error", message: error.message, transient: error.reason === "unavailable" };
    }
  }
  if (failures.length === 0 && Cause.hasDies(result.cause)) {
    // A server without the Kin RPCs answers `Exit.die("Unknown request tag: ...")`.
    const unknownTag = result.cause.reasons
      .filter(Cause.isDieReason)
      .some((reason) => defectMessage(reason.defect).includes("Unknown request tag"));
    if (unknownTag) return { _tag: "notKin" };
    // Any other defect, such as a decode failure, is a broken Kin host, not a missing one.
    return { _tag: "error", message: Cause.pretty(result.cause), transient: false };
  }
  if (Cause.hasInterruptsOnly(result.cause)) return { _tag: "pending" };
  // Transport loss, an unreachable environment, or a timeout says nothing about Kin.
  return { _tag: "error", message: Cause.pretty(result.cause), transient: true };
}

export interface KinHostCandidate {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}

export type KinHost =
  /** Still loading the saved host or waiting on a probe. */
  | { readonly _tag: "searching" }
  /** No environment hosts Kin; hide every Kin entry point. */
  | { readonly _tag: "none" }
  | {
      readonly _tag: "host";
      readonly environmentId: EnvironmentId;
      /** False for a saved host that is offline: show its cache. */
      readonly connected: boolean;
      readonly probe: KinProbe;
    };

const isTransient = (probe: KinProbe) => probe._tag === "error" && probe.transient;

/**
 * Saved host first, unless it isn't Kin or lacks an identity another host has; then the first
 * connected host with an identity, in catalog order; then one without. Earlier pending probes are
 * awaited so the choice stays stable. A transient failure never replaces or picks a host.
 */
export function resolveKinHost(input: {
  readonly candidates: ReadonlyArray<KinHostCandidate>;
  readonly probe: (environmentId: EnvironmentId) => KinProbe;
  /** `undefined` while the saved id is still loading. */
  readonly savedHostId: EnvironmentId | null | undefined;
  /** The directory saved at a host's last answer, read only while it is offline. */
  readonly cachedOrgs?: (environmentId: EnvironmentId) => KinOrgsListResult | null;
}): KinHost {
  if (input.savedHostId === undefined) return { _tag: "searching" };
  const saved = input.candidates.find((c) => c.environmentId === input.savedHostId);
  let fallback: KinHost | null = null;
  if (saved !== undefined) {
    if (!saved.connected) {
      return {
        _tag: "host",
        environmentId: saved.environmentId,
        connected: false,
        probe: kinOfflineProbe(input.cachedOrgs?.(saved.environmentId) ?? null),
      };
    }
    const probe = input.probe(saved.environmentId);
    const host: KinHost = {
      _tag: "host",
      environmentId: saved.environmentId,
      connected: true,
      probe,
    };
    if (probe._tag === "noIdentity") fallback = host;
    else if (probe._tag !== "notKin") return host;
  }
  for (const candidate of input.candidates) {
    if (!candidate.connected || candidate === saved) continue;
    const probe = input.probe(candidate.environmentId);
    if (probe._tag === "pending") return fallback ?? { _tag: "searching" };
    if (probe._tag === "ready") {
      return { _tag: "host", environmentId: candidate.environmentId, connected: true, probe };
    }
    if (fallback === null && probe._tag !== "notKin" && !isTransient(probe)) {
      fallback = { _tag: "host", environmentId: candidate.environmentId, connected: true, probe };
    }
  }
  return fallback ?? { _tag: "none" };
}

/**
 * The host for a route that names its environment, such as a deep link to one chat. Every paired
 * host can be Kin under the same org id, so the route's environment wins over the saved host.
 */
export function resolveKinHostAt(input: {
  readonly candidates: ReadonlyArray<KinHostCandidate>;
  readonly probe: (environmentId: EnvironmentId) => KinProbe;
  readonly environmentId: EnvironmentId;
  readonly cachedOrgs?: (environmentId: EnvironmentId) => KinOrgsListResult | null;
}): KinHost {
  const candidate = input.candidates.find((c) => c.environmentId === input.environmentId);
  if (candidate === undefined) return { _tag: "none" };
  if (!candidate.connected) {
    return {
      _tag: "host",
      environmentId: candidate.environmentId,
      connected: false,
      probe: kinOfflineProbe(input.cachedOrgs?.(candidate.environmentId) ?? null),
    };
  }
  const probe = input.probe(candidate.environmentId);
  if (probe._tag === "notKin") return { _tag: "none" };
  return { _tag: "host", environmentId: candidate.environmentId, connected: true, probe };
}

/**
 * An offline host's probe, from the directory saved at its last answer, so its cache still knows
 * who is who. Without one it stays pending.
 */
export function kinOfflineProbe(cached: KinOrgsListResult | null): KinProbe {
  return cached !== null && cached.me.length > 0
    ? { _tag: "ready", orgs: cached }
    : { _tag: "pending" };
}

/** The id worth saving: only a host that answered with an identity. */
export function kinHostIdToSave(host: KinHost): EnvironmentId | null {
  return host._tag === "host" && host.probe._tag === "ready" ? host.environmentId : null;
}
