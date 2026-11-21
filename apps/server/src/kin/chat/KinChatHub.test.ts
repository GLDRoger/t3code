import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Hub from "./KinChatHub.ts";

const layer = Hub.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const orgId = KinOrgId.make("org");
const personId = KinPersonId.make("owner");
const chatId = KinChatId.make("chat");
const memberId = KinMemberId.make("member");
const seed = Effect.gen(function* () {
  const repo = yield* Repository.KinChatRepository;
  const now = "1970-01-01T00:00:00.000Z";
  yield* repo.insertOrg({ orgId, name: "Kin", createdAt: now });
  yield* repo.insertPerson({
    orgId,
    personId,
    handle: "owner",
    displayName: "Owner",
    githubLogin: null,
    createdAt: now,
  });
  yield* repo.createChat({
    orgId,
    chatId,
    kind: "project_group",
    title: "Test",
    teamId: null,
    directKey: null,
    createdAt: now,
    lastMessageAt: null,
    archivedAt: null,
  });
  yield* repo.addMember({
    orgId,
    chatId,
    memberId,
    principal: { _tag: "person", personId },
    role: "owner",
    joinedAt: now,
    leftAt: null,
    mutedUntil: null,
  });
});

it.effect("delivers only committed viewer events and isolates organizations", () =>
  Effect.gen(function* () {
    const hub = yield* Hub.KinChatHub;
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const first = yield* hub.subscribeForViewer({ _tag: "person", orgId, personId });
    const second = yield* hub.subscribeForViewer({ _tag: "person", orgId, personId });
    const event: Hub.KinChatHubEvent = { type: "read.updated", orgId, chatId, memberId, seq: 1 };
    yield* sql
      .withTransaction(
        hub.publish({ ...event, seq: 0 }).pipe(Effect.andThen(Effect.fail("rollback"))),
      )
      .pipe(Effect.flip);
    yield* hub.publish({ ...event, orgId: KinOrgId.make("other") });
    yield* sql.withTransaction(hub.publish(event));
    yield* hub.publish({ ...event, seq: 2 });
    assert.deepStrictEqual(yield* Stream.runCollect(first.pipe(Stream.take(2))), [
      event,
      { ...event, seq: 2 },
    ]);
    assert.deepStrictEqual(yield* Stream.runCollect(second.pipe(Stream.take(2))), [
      event,
      { ...event, seq: 2 },
    ]);
  }).pipe(Effect.provide(layer)),
);

const viewer = { _tag: "person" as const, orgId, personId };
const read = (seq: number): Hub.KinChatHubEvent => ({
  type: "read.updated",
  orgId,
  chatId,
  memberId,
  seq,
});

it.effect("keeps a slow screen's backlog bounded, and ends it to read again past that", () =>
  Effect.gen(function* () {
    const hub = yield* Hub.KinChatHub;
    yield* seed;
    const within = yield* hub.subscribeForViewer(viewer);
    for (let seq = 1; seq <= Hub.KIN_CHAT_HUB_BACKLOG; seq += 1) yield* hub.publish(read(seq));
    const kept = yield* Stream.runCollect(within.pipe(Stream.take(Hub.KIN_CHAT_HUB_BACKLOG)));
    assert.deepStrictEqual(
      kept.map((event) => (event.type === "read.updated" ? event.seq : 0)),
      Array.from({ length: Hub.KIN_CHAT_HUB_BACKLOG }, (_, index) => index + 1),
    );

    // Ten thousand events wait on a screen that reads none: it holds none of them and ends
    // `unavailable`, so its client resumes from its own cursor. Another screen still hears.
    const slow = yield* hub.subscribeForViewer(viewer);
    const other = yield* hub.subscribeForViewer(viewer);
    for (let seq = 1; seq <= 10_000; seq += 1) {
      yield* hub.publish(read(seq));
      if (seq % 500 === 0) yield* Stream.runDrain(other.pipe(Stream.take(500)));
    }
    const exit = yield* Effect.exit(Stream.runCollect(slow));
    assert.isTrue(Exit.isFailure(exit), "a screen that fell behind ends");
    assert.include(JSON.stringify(exit), "unavailable");
    yield* hub.publish(read(10_001));
    assert.deepStrictEqual(yield* Stream.runCollect(other.pipe(Stream.take(1))), [read(10_001)]);
  }).pipe(Effect.provide(layer)),
);

it.effect("reads a screen's membership once for the events waiting, never for other chats", () =>
  Effect.gen(function* () {
    const hub = yield* Hub.KinChatHub;
    yield* seed;
    let statements = 0;
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          if (typeof span.attributes.get("db.query.text") === "string") statements += 1;
        };
        return span;
      },
    });
    const chatOnly = yield* hub.subscribeForViewer(viewer, chatId);
    const draft = (offset: number): Hub.KinChatHubEvent => ({
      type: "draft.updated",
      orgId,
      chatId,
      draft: { draftId: "draft", agentId: KinAgentId.make("lead"), offset, text: "Half" },
      wakeupId: KinWakeupId.make("wake"),
    });
    for (let offset = 0; offset < 50; offset += 1) {
      yield* hub.publish({
        type: "read.updated",
        orgId,
        chatId: KinChatId.make("elsewhere"),
        memberId,
        seq: offset,
      });
      yield* hub.publish(draft(offset));
    }
    const heard = yield* Stream.runCollect(chatOnly.pipe(Stream.take(50))).pipe(
      Effect.withTracer(tracer),
    );
    assert.deepStrictEqual(
      heard,
      Array.from({ length: 50 }, (_, offset) => draft(offset)),
    );
    // The membership and the wake-up's abort, each once for the waiting batch.
    assert.strictEqual(statements, 2);
  }).pipe(Effect.provide(layer)),
);
