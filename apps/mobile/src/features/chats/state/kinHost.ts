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
  /** A plain T3 server, or Kin with `KIN_ENABLED` off. */
  | { readonly _tag: "notKin" };

const isKinChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

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
      // Only a host never seen as Kin gets here with `unavailable`; known hosts retry it.
      return error.reason === "unavailable"
        ? { _tag: "notKin" }
        : { _tag: "error", message: error.message, transient: false };
    }
  }
  // A server without the Kin RPCs answers `Exit.die("Unknown request tag: ...")`.
  if (failures.length === 0 && Cause.hasDies(result.cause)) return { _tag: "notKin" };
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
        probe: { _tag: "pending" },
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

/** The id worth saving: only a host that answered with an identity. */
export function kinHostIdToSave(host: KinHost): EnvironmentId | null {
  return host._tag === "host" && host.probe._tag === "ready" ? host.environmentId : null;
}
