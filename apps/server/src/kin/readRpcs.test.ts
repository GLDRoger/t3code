import { pairSession } from "./auth/ProofKeySessions.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  AuthSessionId,
  AuthStandardClientScopes,
  type EnvironmentAuthorizationError,
  type KinChatError,
  KinPersonId,
  type KinRpcs,
  type KinWorkEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Rpc from "effect/rpc/Rpc";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Audit from "./approvals/Audit.ts";
import * as KeySeal from "./approvals/KeySeal.ts";
import * as PendingActions from "./approvals/PendingActions.ts";
import * as Chat from "./chat/layer.ts";
import { KinIdentity } from "./chat/KinIdentity.ts";
import * as Kin from "./layer.ts";
import { kinHostDependencies } from "./lead/layer.testkit.ts";
import { KIN_READ_RPCS, type KinReadRpc } from "./readRpcs.ts";
import { makeKinHandlers } from "./rpcHandlers.ts";
import * as KinPulse from "./pulse/KinPulse.ts";

// A file database, so the reader pool runs as it does on a host: in memory there is one connection.
const database = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "kin-read-rpcs-" });
    return Sqlite.layerFromPath(path.join(directory, "state.sqlite"));
  }),
).pipe(Layer.provide(NodeServices.layer));
const root = Kin.layerWithSeal(KeySeal.layerTest()).pipe(
  Layer.provideMerge(kinHostDependencies),
  Layer.provideMerge(Chat.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(
    Layer.merge(PendingActions.layer, PendingActions.ledgerLayer).pipe(
      Layer.provideMerge(Audit.layer),
    ),
  ),
  Layer.provideMerge(database),
);

const ownerSession = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const memberId = KinPersonId.make("zoya");
const memberSession = {
  sessionId: AuthSessionId.make("zoya-session"),
  subject: "zoya",
  method: "browser-session-cookie" as const,
  scopes: [AuthKinChatScope],
};

type KinRpc = (typeof KinRpcs)[number];
type Refusal = EnvironmentAuthorizationError | KinChatError;
type Handlers = Effect.Success<ReturnType<typeof makeKinHandlers>>;
/** Handlers ignore the RPC server's options, so a case passes its payload alone. */
const call = (handlers: Handlers, tag: string, payload: unknown): unknown =>
  Reflect.apply(handlers[tag as keyof Handlers], undefined, [payload]);

/** Where each statement ran: its own acquisition, or the transaction's it ran in. */
const connectionOf = (span: Tracer.AnySpan): unknown => {
  for (let at: Option.Option<Tracer.AnySpan> = Option.some(span); Option.isSome(at);) {
    if (at.value._tag !== "Span") return undefined;
    const seen = at.value.attributes.get("db.connection");
    if (seen !== undefined) return seen;
    at = at.value.parent;
  }
  return undefined;
};

/** Records each statement run where it is provided, and where it ran. */
const recorder = () => {
  const ran: Array<{ readonly sql: string; readonly span: Tracer.Span }> = [];
  const transformer: Statement.Transformer = (statement, _sql, _fiber, span) =>
    Effect.sync(() => {
      ran.push({ sql: statement.compile()[0].replace(/\s+/g, " ").slice(0, 80), span });
      return statement;
    });
  return {
    transformer,
    /** In order, with `reader`, `writer`, or undefined for neither. */
    ran: () => ran.map((one) => ({ sql: one.sql, on: connectionOf(one.span) })),
  };
};

/** Runs `effect`, then names every statement it ran that did not run on a reader. */
const onWriter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { transformer, ran } = recorder();
    const value = yield* effect.pipe(
      Effect.provideService(Statement.CurrentTransformer, transformer),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    );
    assert.isAbove(ran().length, 0);
    return { value, writer: ran().flatMap((one) => (one.on === "reader" ? [] : [one.sql])) };
  });

const seed = Effect.gen(function* () {
  const kin = yield* Kin.KinServer;
  const services = Option.getOrThrow(kin.services);
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(ownerSession.sessionId);
  const [owner] = yield* Context.get(services, KinIdentity).resolve(ownerSession);
  assert.isDefined(owner);
  const { orgId } = owner;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${memberId}, ${orgId}, 'zoya', 'Zoya', '2026-01-01T00:00:00.000Z', 'member')`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES (${memberSession.sessionId}, ${orgId}, ${memberId}, 0)`;
  const handlers = yield* makeKinHandlers(ownerSession);
  const create = (title: string) =>
    call(handlers, "kin.work.create", {
      orgId,
      clientRequestId: `read-rpcs:${title}`,
      title,
    }) as Effect.Effect<{ readonly key: string; readonly rev: number }, Refusal>;
  const mine = yield* create("Invented: book the venue");
  const theirs = yield* create("Invented: send the floor plan");
  yield* call(handlers, "kin.work.assign", {
    orgId,
    key: theirs.key,
    to: { _tag: "person", personId: memberId },
  }) as Effect.Effect<unknown, Refusal>;
  return {
    orgId,
    mine,
    owner: handlers,
    member: yield* makeKinHandlers(memberSession),
  };
});

type Payload<Tag extends KinReadRpc> = Rpc.Payload<Extract<KinRpc, { readonly _tag: Tag }>>;
/** One case per routed method: what a screen asks, and whether a teammate may ask it too. */
const cases = (
  orgId: Payload<"kin.work.summary">["orgId"],
): { readonly [Tag in KinReadRpc]: { payload: Payload<Tag>; member: boolean } } => ({
  "kin.work.summary": { payload: { orgId }, member: true },
  "kin.work.list": { payload: { orgId, open: true, acceptCompactRows: true }, member: true },
  "kin.work.subscribe": { payload: { orgId, acceptRows: true }, member: true },
  "kin.pulse.read": { payload: { orgId, includeHandled: true, limit: 8 }, member: true },
  "kin.pulse.subscribe": { payload: { orgId, includeHandled: true, limit: 8 }, member: true },
  "kin.money.subscribe": {
    payload: {
      orgId,
      parts: ["summary", "cash", "outlook", "budgets", "receipts", "goals", "lists"],
    },
    member: false,
  },
  "kin.work.money": { payload: { orgId, upcomingRows: false }, member: false },
  "kin.work.cash": { payload: { orgId }, member: false },
  "kin.work.outlook": { payload: { orgId }, member: false },
  "kin.work.budgets": { payload: { orgId }, member: false },
  "kin.work.receipts": { payload: { orgId }, member: false },
  "kin.work.lists": { payload: { orgId }, member: false },
  "kin.refreshes.subscribe": { payload: { orgId }, member: true },
});

/** An answer, or a stream's first frame. */
const firstAnswer = (tag: string, result: unknown) =>
  tag.endsWith(".subscribe")
    ? Stream.runHead(result as Stream.Stream<unknown, Refusal>).pipe(Effect.map(Option.getOrThrow))
    : (result as Effect.Effect<unknown, Refusal>);

// Live: the reader pool is worker threads, and a stream's first frame waits out its batch window.
it.live("serves every routed method on a reader, for the owner and a teammate", () =>
  Effect.gen(function* () {
    const { orgId, owner, member } = yield* seed;
    assert.sameMembers([...KIN_READ_RPCS], Object.keys(cases(orgId)));
    const onWriterBy: Record<string, ReadonlyArray<string>> = {};
    for (const [tag, one] of Object.entries(cases(orgId))) {
      const asking = one.member ? { owner, member } : { owner };
      for (const [who, handlers] of Object.entries(asking)) {
        const { writer } = yield* onWriter(firstAnswer(tag, call(handlers, tag, one.payload)));
        if (writer.length > 0) onWriterBy[`${who} ${tag}`] = writer;
      }
    }
    assert.deepStrictEqual(onWriterBy, {});

    // The tick senses on a reader before its transaction; the transaction stays on the writer.
    const { transformer, ran } = recorder();
    yield* KinPulse.tick(orgId, yield* Clock.currentTimeMillis).pipe(
      Effect.provideService(Statement.CurrentTransformer, transformer),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    );
    const firstWrite = ran().findIndex((one) => one.on !== "reader");
    assert.isAbove(firstWrite, 0);
    assert.isTrue(
      ran()
        .slice(firstWrite)
        .every((one) => one.on !== "reader"),
    );
  }).pipe(Effect.provide(root)),
);

it.live("a screen reads its own write at once, and the row stream sends each change in order", () =>
  Effect.gen(function* () {
    const { orgId, owner, mine } = yield* seed;
    const update = (rev: number, title: string) =>
      call(owner, "kin.work.update", { orgId, key: mine.key, rev, title }) as Effect.Effect<
        { readonly rev: number },
        Refusal
      >;
    const list = call(owner, "kin.work.list", {
      orgId,
      open: true,
      acceptCompactRows: true,
    }) as Effect.Effect<{ readonly rows?: ReadonlyArray<{ key: string; title: string }> }, Refusal>;
    let rev = mine.rev;
    for (const round of [1, 2, 3, 4, 5]) {
      const title = `Invented: book the venue, take ${round}`;
      rev = (yield* update(rev, title)).rev;
      const read = yield* onWriter(list);
      assert.deepStrictEqual(read.writer, []);
      assert.strictEqual(read.value.rows?.find((row) => row.key === mine.key)?.title, title);
    }

    const { transformer, ran } = recorder();
    const rows = (
      call(owner, "kin.work.subscribe", { orgId, acceptRows: true }) as Stream.Stream<
        KinWorkEvent,
        Refusal
      >
    ).pipe(
      Stream.provideService(Statement.CurrentTransformer, transformer),
      Stream.provideService(Statement.SpanPropagationEnabled, true),
    );
    const pull = yield* Stream.toPull(rows);
    const titleOf = (event: KinWorkEvent) =>
      event._tag === "upsert" && event.record.key === mine.key ? event.record.title : undefined;
    const heard: Array<string> = [];
    const until = Effect.fn("test.until")(function* (title: string) {
      while (!heard.includes(title))
        for (const event of yield* pull) {
          const seen = titleOf(event);
          if (seen !== undefined) heard.push(seen);
        }
    });
    yield* pull;
    rev = (yield* update(rev, "Invented: first change")).rev;
    yield* until("Invented: first change");
    rev = (yield* update(rev, "Invented: second change")).rev;
    yield* until("Invented: second change");
    assert.deepStrictEqual(heard, ["Invented: first change", "Invented: second change"]);
    assert.deepStrictEqual(
      ran().filter((one) => one.on !== "reader"),
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(root)),
);
