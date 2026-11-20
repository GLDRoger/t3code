import {
  AuthKinChatScope,
  EnvironmentId,
  KIN_APPROVAL_WS_METHODS,
  KinOrgId,
  KinRecordKey,
  type AuthSessionState,
  type KinWorkEvent,
  type KinOrgsListResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { environmentSessionGenerationAtom } from "../state/runtime.ts";
import { makeKinClient, type KinClientPlatform } from "./kinClient.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => grantedSession }),
}));
const grantedSession = Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(
  AsyncResult.success<AuthSessionState>({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthKinChatScope],
    permissions: [AuthKinChatScope],
  }),
);

const env = EnvironmentId.make("kin-host");
const org = KinOrgId.make("org-ambermill");
const otherOrg = KinOrgId.make("org-other");

class HostRefused extends Schema.TaggedError<HostRefused>()("HostRefused", {
  message: Schema.String,
}) {}
type Answers = Record<string, (input: never) => Effect.Effect<unknown, HostRefused>>;

const connected: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

/** A host that answers the named Kin methods and records every call; the rest never answer. */
const fakeHost = Effect.fn("TestKinHost.make")(function* (answers: Answers) {
  const calls: Array<{ readonly tag: string; readonly input: unknown }> = [];
  const client = new Proxy({} as WsRpcProtocolClient, {
    get: (_target, tag: string) => (input: never) => {
      calls.push({ tag, input });
      return answers[tag]?.(input) ?? Effect.never;
    },
  });
  const session = (): RpcSession.RpcSession => ({
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  });
  const supervisorSession = yield* SubscriptionRef.make(Option.some(session()));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: env,
      label: "Ambermill host",
      httpBaseUrl: "https://host.example.test",
      wsBaseUrl: "wss://host.example.test",
    }),
    state: yield* SubscriptionRef.make(connected),
    session: supervisorSession,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const registryService = {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown, HostRefused, never>) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_id: EnvironmentId, stream: Stream.Stream<unknown, HostRefused, never>) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
  );
  /** The socket dropped and came back: a new session on the same host. */
  const reconnect = SubscriptionRef.set(supervisorSession, Option.some(session()));
  const count = (tag: string) => calls.filter((call) => call.tag === tag).length;
  return { runtime, calls, count, reconnect };
});

const setup = Effect.fn("TestKinHost.setup")(function* (
  answers: Answers,
  platform?: KinClientPlatform<never>,
) {
  const host = yield* fakeHost(answers);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { ...host, registry, ...makeKinClient(host.runtime, registry, platform) };
});

/** A read's settled answer, with the read kept mounted for the rest of the test. */
const settled = Effect.fn("TestKinHost.settled")(function* <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  yield* AtomRegistry.mount(registry, atom);
  return yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
    Effect.exit,
  );
});

const directory: KinOrgsListResult = {
  orgs: [{ orgId: org, name: "Ambermill Studio", agents: [] }],
  me: [],
} as unknown as KinOrgsListResult;

describe("makeKinClient", () => {
  it.effect("creates one agent per org and name in flight, whatever the domain says", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const started = yield* Queue.unbounded<KinOrgId>();
        const { kinClient, registry, calls } = yield* setup({
          "kin.lead.create": (input: { readonly orgId: KinOrgId }) =>
            Queue.offer(started, input.orgId).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ outcome: "created" }),
            ),
        });
        const create = (orgId: KinOrgId, domain: string) =>
          Effect.promise(() =>
            kinClient.leadCreate.run(registry, {
              environmentId: env,
              input: { orgId, name: "Finance", domain, charter: "Keeps the books." } as never,
            }),
          );
        // A double tap with the domain edited between the taps, and another company's create.
        const all = yield* Effect.forkChild(
          Effect.all(
            [create(org, "money"), create(org, "money and invoices"), create(otherOrg, "money")],
            { concurrency: "unbounded" },
          ),
        );
        const reached = [yield* Queue.take(started), yield* Queue.take(started)];
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(all);
        expect(reached.toSorted()).toEqual([org, otherOrg].toSorted());
        expect(calls.filter((call) => call.tag === "kin.lead.create")).toHaveLength(2);
      }),
    ),
  );

  it.effect("reads the phones that can approve again once after a reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { kinClient, registry, runtime, count, reconnect } = yield* setup({
          [KIN_APPROVAL_WS_METHODS.listKeys]: () => Effect.succeed({ keys: [], events: [] }),
        });
        // Kin's refresh triggers already follow the session by the time Settings opens.
        const generation = environmentSessionGenerationAtom(runtime, env);
        yield* AtomRegistry.mount(registry, generation);
        yield* AtomRegistry.toStream(registry, generation).pipe(
          Stream.filter((value) => value === 1),
          Stream.runHead,
        );
        const keys = kinClient.approverKeys({ environmentId: env, input: { orgId: org } });
        yield* settled(registry, keys);
        expect(count(KIN_APPROVAL_WS_METHODS.listKeys)).toBe(1);
        yield* reconnect;
        yield* AtomRegistry.toStream(registry, generation).pipe(
          Stream.filter((value) => value === 2),
          Stream.runHead,
        );
        yield* settled(registry, keys);
        expect(count(KIN_APPROVAL_WS_METHODS.listKeys)).toBe(2);
      }),
    ),
  );

  it.effect("reads the agents' In hand lines again when a task in Work changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const asked = yield* Queue.unbounded<void>();
        const work = yield* Queue.unbounded<KinWorkEvent>();
        const { kinClient, registry } = yield* setup({
          "kin.leads.list": () => Queue.offer(asked, undefined).pipe(Effect.as({ leads: [] })),
          "kin.work.subscribe": () => Stream.fromQueue(work),
        } as unknown as Answers);
        yield* settled(registry, kinClient.leads({ environmentId: env, input: { orgId: org } }));
        yield* Queue.take(asked);
        yield* Queue.offer(work, {
          _tag: "counts",
          seq: 1,
          asOf: "2026-11-19T05:00:00.000Z",
          open: 1,
          doing: 0,
          waiting: 1,
          late: 0,
          dueThisWeek: 0,
          whole: true,
          owners: [],
        });
        // W-2 moves from waiting on Rhea to doing on another screen: no `leads` move is sent.
        yield* Queue.offer(work, { _tag: "changed", seq: 2, key: KinRecordKey.make("W-2") });
        yield* Queue.take(asked);
      }),
    ),
  );

  it.effect("reads Check-ins and Profile's Briefs again after either one saves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let at = "10:30";
        const { kinClient, registry, count, refreshKinBriefs } = yield* setup({
          "kin.checkIns.list": () => Effect.sync(() => ({ checkIns: [{ at }] })),
          "kin.briefs.list": () => Effect.sync(() => ({ briefs: [{ at }] })),
        } as unknown as Answers);
        const input = { environmentId: env, input: { orgId: org } };
        const both = Effect.all([
          settled(registry, kinClient.checkIns(input)),
          settled(registry, kinClient.briefs(input)),
        ]);
        yield* both;
        // Rhea saves 09:30 in Profile → Briefs, then opens Check-ins within the read's 30 seconds.
        at = "09:30";
        refreshKinBriefs(env, org);
        const [checkIns, briefs] = yield* both;
        expect([checkIns, briefs]).toEqual([
          Exit.succeed({ checkIns: [{ at: "09:30" }] }),
          Exit.succeed({ briefs: [{ at: "09:30" }] }),
        ]);
        expect([count("kin.checkIns.list"), count("kin.briefs.list")]).toEqual([2, 2]);
      }),
    ),
  );

  it.effect("hands each directory answer to the app's device cache", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const saved: Array<KinOrgsListResult> = [];
        const { kinClient, registry } = yield* setup(
          { "kin.orgs.list": () => Effect.succeed(directory) },
          { onOrgs: (_environmentId, result) => Effect.sync(() => saved.push(result)) },
        );
        yield* settled(registry, kinClient.orgs({ environmentId: env, input: {} }));
        expect(saved).toEqual([directory]);
      }),
    ),
  );

  it.effect("hides an owner-level control until the host says who this is, and still asks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { kinClient, registry, count } = yield* setup({
          "kin.agents.defaults.set": () => Effect.fail(new HostRefused({ message: "not allowed" })),
        });
        yield* AtomRegistry.mount(registry, kinClient.agentDefaultsSet.permissionAtom(env));
        expect(registry.get(kinClient.agentDefaultsSet.permissionAtom(env))).toBe(false);
        // The hidden control is a courtesy: a call still goes, and the host's answer is the answer.
        const outcome = yield* Effect.promise(() =>
          kinClient.agentDefaultsSet.run(registry, {
            environmentId: env,
            input: { orgId: org } as never,
          }),
        );
        expect(count("kin.agents.defaults.set")).toBe(1);
        expect(AsyncResult.isFailure(outcome)).toBe(true);
      }),
    ),
  );
});
