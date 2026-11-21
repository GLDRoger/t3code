import {
  EnvironmentAuthorizationError,
  KinChatError,
  type EnvironmentId,
  type KinOrgsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentConnectionPresentation } from "../connection/presentation.ts";

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

/** A server without the call answers `Exit.die("Unknown request tag: ...")`. */
export const kinHostLacksCall = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .filter(Cause.isDieReason)
    .some((reason) => defectMessage(reason.defect).includes("Unknown request tag"));

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
    if (kinHostLacksCall(result.cause)) return { _tag: "notKin" };
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
  /** Its first connection attempt hasn't ended yet, so whether it is reachable isn't known. */
  readonly connecting?: boolean;
  /** Down for more than a blip: switched off, failing, or unsupported. See `kinHostCandidate`. */
  readonly down?: boolean;
  /** Switched off on this device by the person, which is not the same as unreachable. */
  readonly off?: boolean;
}

/**
 * One environment as a Kin host candidate. A first `connecting` or a `reconnecting` that hasn't
 * failed yet is a blip, so the saved host holds through it; `available` is a switched-off one.
 */
export function kinHostCandidate(
  environmentId: EnvironmentId,
  connection: Pick<EnvironmentConnectionPresentation, "phase" | "error">,
): KinHostCandidate {
  const { phase } = connection;
  return {
    environmentId,
    connected: phase === "connected",
    connecting: phase === "connecting",
    off: phase === "available",
    down:
      phase === "available" ||
      phase === "offline" ||
      phase === "error" ||
      phase === "unsupported" ||
      (phase === "reconnecting" && connection.error !== null),
  };
}

export type KinHost =
  /** Still loading the saved host or waiting on a probe. */
  | { readonly _tag: "searching" }
  /**
   * No environment hosts Kin; hide every Kin entry point. `unreachable`: some saved here aren't
   * answering, so Kin may be on one of them, rather than none running it.
   */
  | { readonly _tag: "none"; readonly unreachable?: true }
  | {
      readonly _tag: "host";
      readonly environmentId: EnvironmentId;
      /** False for a saved host that is offline: show its cache. */
      readonly connected: boolean;
      /** Not connected yet because its first attempt is still under way: not known to be offline. */
      readonly connecting?: true;
      readonly probe: KinProbe;
      /**
       * The saved host this one stands in for while it is down; never saved, so Kin goes back
       * when it returns.
       */
      readonly standInFor?: EnvironmentId;
      /** The saved host was switched off here, so standing in needs no warning. */
      readonly usualOff?: true;
    };

/** A route's host; `unpaired` when this device's catalog doesn't hold the route's environment. */
export type KinRouteHost = KinHost | { readonly _tag: "unpaired" };

const isTransient = (probe: KinProbe) => probe._tag === "error" && probe.transient;

/**
 * Saved host first, unless it isn't Kin or lacks an identity another host has; a saved host that
 * is down lends its place, unsaved, to a connected one with an identity. Then the first connected
 * host with an identity in catalog order, awaiting earlier probes; then one without. A transient
 * failure never replaces or picks a host.
 */
export function resolveKinHost(input: {
  readonly candidates: ReadonlyArray<KinHostCandidate>;
  readonly probe: (environmentId: EnvironmentId) => KinProbe;
  /** `undefined` while the saved id is still loading. */
  readonly savedHostId: EnvironmentId | null | undefined;
  /** The directory saved at a host's last answer, read only while it is offline. */
  readonly cachedOrgs?: (environmentId: EnvironmentId) => KinOrgsListResult | null;
  /** The last answer. A stand-in stays until the saved host is back, not just retrying. */
  readonly previous?: KinHost;
}): KinHost {
  if (input.savedHostId === undefined) return { _tag: "searching" };
  const saved = input.candidates.find((c) => c.environmentId === input.savedHostId);
  let fallback: KinHost | null = null;
  if (saved !== undefined) {
    const { previous } = input;
    // Coming to the front, every socket starts over as a first attempt, which looks like a blip:
    // the stand-in holds through its own blip too, and leaves only once it is really down.
    const standIn =
      !saved.connected && previous?._tag === "host" && previous.standInFor === saved.environmentId
        ? input.candidates.find((c) => c.environmentId === previous.environmentId && !c.down)
        : undefined;
    if (previous?._tag === "host" && standIn !== undefined) {
      const probe = input.probe(standIn.environmentId);
      return {
        ...previous,
        connected: standIn.connected,
        probe: standIn.connected && probe._tag === "ready" ? probe : previous.probe,
      };
    }
    if (!saved.connected) {
      // A live host stands in for one that is down, awaiting earlier probes like the search below
      // so it doesn't pick one and switch; a blip shows the saved host's cache.
      let live: KinHostCandidate | undefined;
      for (const candidate of saved.down ? input.candidates : []) {
        if (!candidate.connected) continue;
        const tag = input.probe(candidate.environmentId)._tag;
        if (tag === "pending") break;
        if (tag === "ready") {
          live = candidate;
          break;
        }
      }
      if (live !== undefined) {
        return {
          _tag: "host",
          environmentId: live.environmentId,
          connected: true,
          probe: input.probe(live.environmentId),
          standInFor: saved.environmentId,
          ...(saved.off === true ? { usualOff: true as const } : {}),
        };
      }
      return {
        _tag: "host",
        environmentId: saved.environmentId,
        connected: false,
        ...connectingOf(saved),
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
  if (fallback !== null) return fallback;
  return input.candidates.some((candidate) => !candidate.connected)
    ? { _tag: "none", unreachable: true }
    : { _tag: "none" };
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
}): KinRouteHost {
  const candidate = input.candidates.find((c) => c.environmentId === input.environmentId);
  if (candidate === undefined) return { _tag: "unpaired" };
  if (!candidate.connected) {
    return {
      _tag: "host",
      environmentId: candidate.environmentId,
      connected: false,
      ...connectingOf(candidate),
      probe: kinOfflineProbe(input.cachedOrgs?.(candidate.environmentId) ?? null),
    };
  }
  const probe = input.probe(candidate.environmentId);
  if (probe._tag === "notKin") return { _tag: "none" };
  return { _tag: "host", environmentId: candidate.environmentId, connected: true, probe };
}

const connectingOf = (candidate: KinHostCandidate) =>
  candidate.connecting === true ? { connecting: true as const } : {};

/**
 * What is known about reaching a host: `connecting` until its first attempt ends, so no screen
 * says offline before an attempt has failed or a live connection was lost.
 */
export type KinLink = "connecting" | "connected" | "offline";

export function kinHostLink(host: KinRouteHost): KinLink {
  if (host._tag === "searching") return "connecting";
  if (host._tag !== "host") return "offline";
  if (host.connected) return "connected";
  return host.connecting === true ? "connecting" : "offline";
}

/**
 * An offline host's probe, from the directory saved at its last answer, so its cache still knows
 * who is who. Without one it stays pending.
 */
function kinOfflineProbe(cached: KinOrgsListResult | null): KinProbe {
  return cached !== null && cached.me.length > 0
    ? { _tag: "ready", orgs: cached }
    : { _tag: "pending" };
}

/** The id worth saving: only a host that answered with an identity, and not a stand-in. */
export function kinHostIdToSave(host: KinHost): EnvironmentId | null {
  return host._tag === "host" && host.probe._tag === "ready" && host.standInFor === undefined
    ? host.environmentId
    : null;
}

/**
 * The line a stand-in host shows, so nobody writes to another host's Kin unawares; null when the
 * usual host shows or never named this person. Computers are named only to owner level.
 */
export function kinStandInLine(
  host: KinHost,
  labelOf: (environmentId: EnvironmentId) => string | null,
  ownerLevel: boolean,
  usualDirectory: KinOrgsListResult | null,
): {
  readonly message: string;
  readonly usual: EnvironmentId;
  readonly shown: EnvironmentId;
} | null {
  // Switched off here on purpose: the person knows, and nothing is wrong.
  if (host._tag !== "host" || host.standInFor === undefined || host.usualOff) return null;
  if (usualDirectory === null || usualDirectory.me.length === 0) return null;
  const label = (environmentId: EnvironmentId) => (ownerLevel ? labelOf(environmentId) : null);
  const shown = label(host.environmentId) ?? "another computer";
  const named = label(host.standInFor);
  // Two machines can share a name; then only "usual" tells them apart.
  const usual = named === null || named === shown ? "Your usual computer" : named;
  return {
    message: `Showing ${shown}. ${usual} can't be reached.`,
    usual: host.standInFor,
    shown: host.environmentId,
  };
}

/** The action that makes the computer standing in the usual one, so the line goes for good. */
export const KIN_USE_THIS_HOST = "Use this one";

/**
 * The app's Kin host and a route's host, one wiring for web and phone. Each app passes its own
 * candidates, probe, offline directory and saved id; `savedHostId` is `undefined` while it loads.
 */
export function makeKinHostAtoms(source: {
  readonly ready: (get: Atom.AtomContext) => boolean;
  readonly candidates: (get: Atom.AtomContext) => ReadonlyArray<KinHostCandidate>;
  readonly probe: (get: Atom.AtomContext) => (environmentId: EnvironmentId) => KinProbe;
  readonly cachedOrgs: (
    get: Atom.AtomContext,
  ) => (environmentId: EnvironmentId) => KinOrgsListResult | null;
  readonly savedHostId: (get: Atom.AtomContext) => EnvironmentId | null | undefined;
  /** Called before the saved host's first probe, so an outage there keeps it, not hides Kin. */
  readonly markKnown: (environmentId: EnvironmentId) => void;
}) {
  const hostAtom: Atom.Atom<KinHost> = Atom.make((get): KinHost => {
    if (!source.ready(get)) return { _tag: "searching" };
    const savedHostId = source.savedHostId(get);
    if (savedHostId) source.markKnown(savedHostId);
    return resolveKinHost({
      candidates: source.candidates(get),
      savedHostId,
      probe: source.probe(get),
      cachedOrgs: source.cachedOrgs(get),
      ...Option.match(get.self<KinHost>(), {
        onNone: () => ({}),
        onSome: (previous) => ({ previous }),
      }),
    });
  }).pipe(Atom.withLabel("kin:host"));

  const hostAtAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): KinRouteHost => {
      if (!source.ready(get)) return { _tag: "searching" };
      return resolveKinHostAt({
        candidates: source.candidates(get),
        environmentId,
        probe: source.probe(get),
        cachedOrgs: source.cachedOrgs(get),
      });
    }).pipe(Atom.withLabel(`kin:host:${environmentId}`)),
  );
  return { hostAtom, hostAtAtom };
}
