import type { EnvironmentConnectionPresentation } from "../connection/presentation.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/index.ts";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  KinChatError,
  type KinOrgsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyKinProbe,
  kinHostCandidate,
  kinHostLink,
  kinHostIdToSave,
  kinStandInLine,
  makeKinHostAtoms,
  resolveKinHost,
  resolveKinHostAt,
  type KinHost,
  type KinProbe,
} from "./kinHost.ts";

const orgs = (me: KinOrgsListResult["me"]) =>
  ({
    orgs: [
      { orgId: "kin-default", name: "Kin", createdAt: "2026-11-08T00:00:00.000Z", agents: [] },
    ],
    me,
  }) as unknown as KinOrgsListResult;
const withIdentity = orgs([{ orgId: "kin-default", personId: "kin-default-owner" }] as never);

const fail = (error: unknown) => AsyncResult.failure(Cause.fail(error));

describe("classifyKinProbe", () => {
  it.each([
    ["pending", AsyncResult.initial(true), { _tag: "pending" }],
    ["an identity", AsyncResult.success(withIdentity), { _tag: "ready" }],
    ["an empty me", AsyncResult.success(orgs([])), { _tag: "noIdentity" }],
    [
      "Kin turned off",
      fail(new KinChatError({ reason: "disabled", message: "off" })),
      { _tag: "notKin" },
    ],
    [
      "a Kin outage",
      fail(new KinChatError({ reason: "unavailable", message: "down" })),
      { _tag: "error", transient: true },
    ],
    [
      "a plain T3 server",
      AsyncResult.failure(Cause.die("Unknown request tag: kin.orgs.list")),
      { _tag: "notKin" },
    ],
    [
      "a plain T3 server's decoded defect",
      AsyncResult.failure(Cause.die(new Error("Unknown request tag: kin.orgs.list"))),
      { _tag: "notKin" },
    ],
    [
      "a decode failure",
      AsyncResult.failure(Cause.die(new Error('Expected string, got undefined at ["me"]'))),
      { _tag: "error", transient: false },
    ],
    [
      "a Kin refusal",
      fail(new KinChatError({ reason: "not_allowed", message: "no" })),
      { _tag: "error", transient: false },
    ],
    [
      "a lost transport",
      fail(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({ message: "socket closed", cause: null }),
        }),
      ),
      { _tag: "error", transient: true },
    ],
    [
      "an unreachable environment",
      fail(new EnvironmentRpcUnavailableError({ environmentId: "env-a", message: "offline" })),
      { _tag: "error", transient: true },
    ],
    [
      "a missing scope",
      fail(
        new EnvironmentAuthorizationError({
          message: "This connection requires orchestration:read.",
          requiredScope: "orchestration:read",
        }),
      ),
      { _tag: "unauthorized" },
    ],
  ] as const)("classifies %s", (_name, result, expected) => {
    expect(
      classifyKinProbe(result as AsyncResult.AsyncResult<KinOrgsListResult, unknown>),
    ).toMatchObject(expected);
  });
});

const a = EnvironmentId.make("env-a");
const b = EnvironmentId.make("env-b");
const c = EnvironmentId.make("env-c");
const ready: KinProbe = { _tag: "ready", orgs: withIdentity };
const notKin: KinProbe = { _tag: "notKin" };
const pending: KinProbe = { _tag: "pending" };

const resolve = (
  probes: Record<string, KinProbe>,
  options: {
    savedHostId?: EnvironmentId | null;
    /** Not connected; a blip such as the first `connecting` unless `phases` says otherwise. */
    offline?: ReadonlyArray<EnvironmentId>;
    phases?: Record<string, Pick<EnvironmentConnectionPresentation, "phase" | "error">>;
    cached?: Record<string, KinOrgsListResult>;
    previous?: KinHost;
  } = {},
) =>
  resolveKinHost({
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    candidates: [a, b, c].map((environmentId) =>
      kinHostCandidate(
        environmentId,
        options.phases?.[environmentId] ??
          ((options.offline ?? []).includes(environmentId)
            ? { phase: "connecting", error: null }
            : { phase: "connected", error: null }),
      ),
    ),
    savedHostId: options.savedHostId === undefined ? null : options.savedHostId,
    probe: (environmentId) => probes[environmentId] ?? notKin,
    cachedOrgs: (environmentId) => options.cached?.[environmentId] ?? null,
  });

describe("resolveKinHost", () => {
  it("hides Kin when no environment hosts it", () => {
    expect(resolve({})).toEqual({ _tag: "none" });
  });

  it("waits for the saved host id to load", () => {
    expect(
      resolveKinHost({ candidates: [], savedHostId: undefined, probe: () => ready })._tag,
    ).toBe("searching");
  });

  it("picks the first Kin host in catalog order, waiting on earlier probes", () => {
    expect(resolve({ [b]: ready, [c]: ready })).toMatchObject({ _tag: "host", environmentId: b });
    expect(resolve({ [a]: pending, [b]: ready })).toEqual({ _tag: "searching" });
  });

  it("keeps the saved host, even offline, so its cache can show", () => {
    expect(resolve({ [b]: ready, [c]: ready }, { savedHostId: c })).toMatchObject({
      environmentId: c,
      connected: true,
    });
    expect(resolve({ [b]: pending }, { savedHostId: c, offline: [c] })).toMatchObject({
      _tag: "host",
      environmentId: c,
      connected: false,
      probe: pending,
    });
  });

  it.each([
    ["connecting for the first time", { phase: "connecting", error: null }, "connecting"],
    ["reconnecting before any attempt failed", { phase: "reconnecting", error: null }, "offline"],
  ] as const)(
    "holds the saved host's cache while it is %s, saving nothing",
    (_name, phase, link) => {
      const host = resolve({ [b]: ready }, { savedHostId: c, phases: { [c]: phase } });
      expect(host).toMatchObject({ environmentId: c, connected: false });
      expect(kinHostLink(host)).toBe(link);
      expect(host).not.toHaveProperty("standInFor");
    },
  );

  it.each([
    ["unreachable after a failed attempt", { phase: "reconnecting", error: "timed out" }],
    ["failing", { phase: "error", error: "refused" }],
    ["unsupported", { phase: "unsupported", error: "too old" }],
    ["offline", { phase: "offline", error: null }],
  ] as const)("lets a live host stand in, unsaved, for a saved host %s", (_name, phase) => {
    const host = resolve({ [b]: ready }, { savedHostId: c, phases: { [c]: phase } });
    expect(host).toMatchObject({ environmentId: b, connected: true, probe: ready, standInFor: c });
    expect(kinHostIdToSave(host)).toBeNull();
    const names = new Map([[b, "Studio Mac"]]);
    expect(kinStandInLine(host, (id) => names.get(id) ?? null, true, withIdentity)).toEqual({
      message: "Showing Studio Mac. Your usual computer can't be reached.",
      usual: c,
      shown: b,
    });
    // A usual computer that never named this person held none of their Kin: nothing to warn of.
    expect(kinStandInLine(host, () => "Studio Mac", true, null)).toBeNull();
    expect(kinStandInLine(host, () => "Studio Mac", true, orgs([]))).toBeNull();
    expect(kinStandInLine(host, () => "Studio Mac", true, withIdentity)?.message).toBe(
      "Showing Studio Mac. Your usual computer can't be reached.",
    );
    names.set(c, "Office Mac");
    expect(kinStandInLine(host, (id) => names.get(id) ?? null, true, withIdentity)?.message).toBe(
      "Showing Studio Mac. Office Mac can't be reached.",
    );
    // A teammate never reads a computer's name.
    expect(kinStandInLine(host, (id) => names.get(id) ?? null, false, withIdentity)?.message).toBe(
      "Showing another computer. Your usual computer can't be reached.",
    );
  });

  it("stands in quietly for a saved host switched off on this device", () => {
    const host = resolve(
      { [b]: ready },
      { savedHostId: c, phases: { [c]: { phase: "available", error: null } } },
    );
    expect(host).toMatchObject({ environmentId: b, connected: true, standInFor: c });
    expect(kinHostIdToSave(host)).toBeNull();
    expect(kinStandInLine(host, () => "Studio Mac", true, withIdentity)).toBeNull();
  });

  it("waits on an earlier host's probe before letting a later one stand in", () => {
    const down = { [c]: { phase: "available", error: null } } as const;
    expect(resolve({ [a]: pending, [b]: ready }, { savedHostId: c, phases: down })).toMatchObject({
      environmentId: c,
      connected: false,
    });
    expect(resolve({ [a]: notKin, [b]: ready }, { savedHostId: c, phases: down })).toMatchObject({
      environmentId: b,
      standInFor: c,
    });
  });

  it("goes back to the saved host once it reconnects, and keeps its cache with no live host", () => {
    const down = { [c]: { phase: "available", error: null } } as const;
    expect(resolve({ [b]: ready }, { savedHostId: c, phases: down })).toMatchObject({
      environmentId: b,
    });
    const back = resolve({ [b]: ready, [c]: ready }, { savedHostId: c });
    expect(back).toMatchObject({ environmentId: c, connected: true });
    expect(kinStandInLine(back, () => "Office Mac", true, withIdentity)).toBeNull();
    expect(kinHostIdToSave(back)).toBe(c);
    const noIdentity: KinProbe = { _tag: "noIdentity", orgs: orgs([]) };
    const flaky: KinProbe = { _tag: "error", message: "socket closed", transient: true };
    expect(
      resolve({ [a]: noIdentity, [b]: flaky }, { savedHostId: c, phases: down }),
    ).toMatchObject({ environmentId: c, connected: false });
  });

  it("keeps a stand-in while the saved host retries from scratch, as on coming to the front", () => {
    const refused = { phase: "error", error: "refused" } as const;
    const restarting = { phase: "connecting", error: null } as const;
    const failing = { [c]: refused };
    const standing = resolve({ [b]: ready }, { savedHostId: c, phases: failing });
    expect(standing).toMatchObject({ environmentId: b, standInFor: c });
    // Back in front, the saved host starts over: a first attempt with no failure yet.
    const retry = { [c]: restarting };
    expect(
      resolve({ [b]: ready }, { savedHostId: c, phases: retry, previous: standing }),
    ).toMatchObject({ environmentId: b, connected: true, standInFor: c });
    // Once it answers, Kin goes back to it.
    expect(
      resolve({ [b]: ready, [c]: ready }, { savedHostId: c, previous: standing }),
    ).toMatchObject({ environmentId: c, connected: true });
    // The stand-in restarts too; it holds through its own blip.
    expect(
      resolve(
        { [b]: ready },
        { savedHostId: c, phases: { ...retry, [b]: restarting }, previous: standing },
      ),
    ).toMatchObject({ environmentId: b, standInFor: c, probe: ready });
    // A stand-in that is really down leaves the saved host's cache.
    expect(
      resolve(
        { [b]: ready },
        { savedHostId: c, phases: { ...retry, [b]: refused }, previous: standing },
      ),
    ).toMatchObject({ environmentId: c, connected: false });

    // The app's host atom feeds its last answer back, on web as on the phone.
    const phases =
      Atom.make<Record<string, Pick<EnvironmentConnectionPresentation, "phase" | "error">>>(
        failing,
      );
    const known: Array<EnvironmentId> = [];
    const { hostAtom } = makeKinHostAtoms({
      ready: () => true,
      candidates: (get) =>
        [b, c].map((environmentId) =>
          kinHostCandidate(
            environmentId,
            get(phases)[environmentId] ?? { phase: "connected", error: null },
          ),
        ),
      probe: () => (environmentId) => (environmentId === b ? ready : pending),
      cachedOrgs: () => () => null,
      savedHostId: () => c,
      markKnown: (environmentId) => known.push(environmentId),
    });
    const registry = AtomRegistry.make();
    expect(registry.get(hostAtom)).toMatchObject({ environmentId: b, standInFor: c });
    registry.set(phases, retry);
    expect(registry.get(hostAtom)).toMatchObject({ environmentId: b, standInFor: c });
    expect(new Set(known)).toEqual(new Set([c]));
  });

  it("saves a host picked over a saved one that isn't Kin or has no identity", () => {
    const noIdentity: KinProbe = { _tag: "noIdentity", orgs: orgs([]) };
    expect(kinHostIdToSave(resolve({ [a]: notKin, [b]: ready }, { savedHostId: a }))).toBe(b);
    expect(kinHostIdToSave(resolve({ [a]: noIdentity, [b]: ready }, { savedHostId: a }))).toBe(b);
  });

  it.each([
    ["the saved directory", { [c]: withIdentity }, ready],
    ["a saved directory without an identity", { [c]: orgs([]) }, pending],
    ["no saved directory", {}, pending],
  ])("reads an offline saved host's identity from %s", (_name, cached, probe) => {
    expect(resolve({}, { savedHostId: c, offline: [c], cached })).toMatchObject({
      connected: false,
      probe,
    });
  });

  it("keeps the saved host through a transient failure, and never picks one that failed", () => {
    const flaky: KinProbe = { _tag: "error", message: "socket closed", transient: true };
    expect(resolve({ [a]: flaky, [b]: ready }, { savedHostId: a })).toMatchObject({
      environmentId: a,
      probe: { _tag: "error" },
    });
    expect(resolve({ [a]: flaky, [b]: ready })).toMatchObject({ environmentId: b });
    expect(resolve({ [a]: flaky })).toEqual({ _tag: "none" });
  });

  it("moves on from a saved host that is no longer Kin or left the catalog", () => {
    expect(resolve({ [b]: ready }, { savedHostId: a })).toMatchObject({ environmentId: b });
    expect(resolve({ [b]: ready }, { savedHostId: EnvironmentId.make("gone") })).toMatchObject({
      environmentId: b,
    });
  });

  it("prefers a host with an identity, and falls back to one without", () => {
    const noIdentity: KinProbe = { _tag: "noIdentity", orgs: orgs([]) };
    expect(resolve({ [a]: noIdentity, [b]: ready })).toMatchObject({ environmentId: b });
    const host = resolve({ [a]: noIdentity });
    expect(host).toMatchObject({ environmentId: a, probe: { _tag: "noIdentity" } });
    expect(kinHostIdToSave(host)).toBeNull();
    expect(kinHostIdToSave(resolve({ [b]: ready }))).toBe(b);
    expect(resolve({ [a]: noIdentity, [b]: ready }, { savedHostId: a })).toMatchObject({
      environmentId: b,
    });
    expect(resolve({ [a]: noIdentity }, { savedHostId: a })).toMatchObject({ environmentId: a });
  });

  it("ignores offline environments it has not saved", () => {
    expect(resolve({ [a]: ready }, { offline: [a] })).toEqual({ _tag: "none" });
  });
});

describe("resolveKinHostAt", () => {
  const at = (
    environmentId: EnvironmentId,
    probes: Record<string, KinProbe>,
    offline: ReadonlyArray<EnvironmentId> = [],
  ) =>
    resolveKinHostAt({
      candidates: [a, b].map((id) => ({ environmentId: id, connected: !offline.includes(id) })),
      environmentId,
      probe: (id) => probes[id] ?? notKin,
      cachedOrgs: (id) => (id === a ? withIdentity : null),
    });

  it("uses the route's host, not the first or saved Kin host", () => {
    expect(at(b, { [a]: ready, [b]: ready })).toMatchObject({
      _tag: "host",
      environmentId: b,
      connected: true,
    });
  });

  it("keeps an offline route host so its cache or offline state shows", () => {
    expect(at(a, { [b]: ready }, [a])).toMatchObject({
      _tag: "host",
      environmentId: a,
      connected: false,
      probe: ready,
    });
    expect(at(b, { [b]: ready }, [b])).toMatchObject({ connected: false, probe: pending });
  });

  it.each([
    ["connecting", null, "connecting"],
    ["connected", null, "connected"],
    ["reconnecting", null, "offline"],
    ["reconnecting", "refused", "offline"],
    ["error", "refused", "offline"],
    ["offline", null, "offline"],
  ] as const)("reads a %s route host (error %s) as %s", (phase, error, link) => {
    const host = resolveKinHostAt({
      candidates: [kinHostCandidate(a, { phase, error })],
      environmentId: a,
      probe: () => ready,
    });
    expect(kinHostLink(host)).toBe(link);
  });

  it("tells an unpaired route environment from one that isn't Kin", () => {
    expect(at(EnvironmentId.make("gone"), { [a]: ready })).toEqual({ _tag: "unpaired" });
    expect(at(b, { [a]: ready })).toEqual({ _tag: "none" });
    expect(at(a, { [a]: pending })).toMatchObject({ environmentId: a, probe: pending });
  });
});
