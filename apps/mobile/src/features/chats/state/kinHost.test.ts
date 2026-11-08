import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  KinChatError,
  type KinOrgsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/rpc";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyKinProbe,
  kinHostIdToSave,
  resolveKinHost,
  resolveKinHostAt,
  type KinProbe,
} from "./kinHost";

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
    ["pending", AsyncResult.initial(true), "pending"],
    ["an identity", AsyncResult.success(withIdentity), "ready"],
    ["an empty me", AsyncResult.success(orgs([])), "noIdentity"],
    ["Kin turned off", fail(new KinChatError({ reason: "unavailable", message: "off" })), "notKin"],
    ["a plain T3 server", AsyncResult.failure(Cause.die(new Error("unknown method"))), "notKin"],
    ["a Kin refusal", fail(new KinChatError({ reason: "not_allowed", message: "no" })), "error"],
    [
      "a lost transport",
      fail(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({ message: "socket closed", cause: null }),
        }),
      ),
      "error",
    ],
    [
      "an unreachable environment",
      fail(new EnvironmentRpcUnavailableError({ environmentId: "env-a", message: "offline" })),
      "error",
    ],
    [
      "a missing scope",
      fail(
        new EnvironmentAuthorizationError({
          message: "This connection requires orchestration:read.",
          requiredScope: "orchestration:read",
        }),
      ),
      "unauthorized",
    ],
  ] as const)("classifies %s", (_name, result, tag) => {
    expect(
      classifyKinProbe(result as AsyncResult.AsyncResult<KinOrgsListResult, unknown>)._tag,
    ).toBe(tag);
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
  options: { savedHostId?: EnvironmentId | null; offline?: ReadonlyArray<EnvironmentId> } = {},
) =>
  resolveKinHost({
    candidates: [a, b, c].map((environmentId) => ({
      environmentId,
      connected: !(options.offline ?? []).includes(environmentId),
    })),
    savedHostId: options.savedHostId === undefined ? null : options.savedHostId,
    probe: (environmentId) => probes[environmentId] ?? notKin,
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
    expect(resolve({ [b]: ready }, { savedHostId: c, offline: [c] })).toMatchObject({
      _tag: "host",
      environmentId: c,
      connected: false,
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
    });
  });

  it("tells an unpaired route environment from one that isn't Kin", () => {
    expect(at(EnvironmentId.make("gone"), { [a]: ready })).toEqual({ _tag: "unpaired" });
    expect(at(b, { [a]: ready })).toEqual({ _tag: "none" });
    expect(at(a, { [a]: pending })).toMatchObject({ environmentId: a, probe: pending });
  });
});
