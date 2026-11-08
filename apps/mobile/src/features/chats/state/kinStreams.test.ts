import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { queryPersistenceKey } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  KIN_CHAT_WS_METHODS,
  type KinChatHistoryInput,
  type KinChatId,
  type KinChatListEvent,
  type KinChatStreamEvent,
  type KinChatSubscribeInput,
  type KinChatSummary,
  type KinMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { MobileDatabase } from "../../../persistence/mobile-database";
import { KinChatState, type KinInboxState } from "./kinInboxModel";
import { KIN_CHAT_LABEL, kinInboxStream, makeKinChatStream, type KinSynced } from "./kinStreams";

const environmentId = EnvironmentId.make("kin-host");
const chatId = "c1" as KinChatId;
const at = "2026-11-08T09:00:00.000Z";

const message = (seq: number, body = `message ${seq}`) =>
  ({
    orgId: "org",
    chatId,
    messageId: `m${seq}`,
    seq,
    author: { _tag: "system" },
    authorRole: "owner",
    kind: "text",
    body,
    intent: null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    createdAt: at,
    editedAt: null,
  }) as unknown as KinMessage;

const summary = (id: string) =>
  ({
    orgId: "org",
    chatId: id,
    kind: "direct",
    title: id,
    teamId: null,
    lastSeq: 1,
    lastMessageAt: at,
    createdAt: at,
    archivedAt: null,
    members: [],
    lastMessage: null,
    unread: 0,
  }) as unknown as KinChatSummary;

const leftEvent = {
  _tag: "member",
  member: { orgId: "org", chatId, memberId: "me", leftAt: at },
} as unknown as KinChatStreamEvent;

const chatRowKey = `v1:${queryPersistenceKey(KIN_CHAT_LABEL, { chatId })}`;
const encodeCachedChat = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.toCodecJson(Schema.Struct({ chat: KinChatState, savedAt: Schema.String })),
  ),
);

function fakeDatabase(rows: Map<string, string>) {
  const id = (kind: string, key: string) => `${kind}|${key}`;
  return {
    loadCache: (_environmentId: EnvironmentId, kind: string, key: string) =>
      Effect.sync(() => Option.fromNullishOr(rows.get(id(kind, key)))),
    saveCache: (
      _environmentId: EnvironmentId,
      kind: string,
      key: string,
      _version: number,
      payload: string,
    ) => Effect.sync(() => void rows.set(id(kind, key), payload)),
    removeCache: (_environmentId: EnvironmentId, kind: string, key: string) =>
      Effect.sync(() => void rows.delete(id(kind, key))),
    clearCacheKind: () => Effect.sync(() => rows.clear()),
  } as unknown as MobileDatabase["Service"];
}

function fakeSession(streams: {
  readonly chat: (input: KinChatSubscribeInput) => Stream.Stream<KinChatStreamEvent>;
  readonly inbox: Stream.Stream<KinChatListEvent>;
}): RpcSession {
  return {
    client: {
      [KIN_CHAT_WS_METHODS.chatSubscribe]: streams.chat,
      [KIN_CHAT_WS_METHODS.chatsSubscribe]: () => streams.inbox,
    },
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  } as unknown as RpcSession;
}

describe("Kin streams", () => {
  it.effect("resumes from the current state across sessions and drops a left chat", () =>
    Effect.gen(function* () {
      const rows = new Map<string, string>();
      rows.set(
        `kin|${chatRowKey}`,
        encodeCachedChat({
          chat: {
            messages: [message(1), message(2)],
            widgets: [],
            contiguousSeq: 2,
            reads: {},
            needsHistoryReload: false,
            left: false,
            closed: null,
          },
          savedAt: "cached-at",
        }),
      );

      const subscribed = yield* Queue.unbounded<KinChatSubscribeInput>();
      const historyReads = yield* Queue.unbounded<KinChatHistoryInput>();
      const firstChat = yield* Queue.unbounded<KinChatStreamEvent>();
      const secondChat = yield* Queue.unbounded<KinChatStreamEvent>();
      const firstInbox = yield* Queue.unbounded<KinChatListEvent>();
      const chatViews = yield* Queue.unbounded<KinSynced<KinChatState>>();
      const inboxViews = yield* Queue.unbounded<KinSynced<KinInboxState>>();
      const session = (
        events: Queue.Queue<KinChatStreamEvent>,
        inbox: Stream.Stream<KinChatListEvent>,
      ) =>
        fakeSession({
          chat: (input) =>
            Stream.fromEffect(Queue.offer(subscribed, input)).pipe(
              Stream.drain,
              Stream.concat(Stream.fromQueue(events)),
            ),
          inbox,
        });

      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some(session(firstChat, Stream.fromQueue(firstInbox))),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Kin host",
          httpBaseUrl: "https://kin.example.test",
          wsBaseUrl: "wss://kin.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
        session: activeSession,
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const provide = <A, E>(
        effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor | MobileDatabase>,
      ) =>
        effect.pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(MobileDatabase, fakeDatabase(rows)),
        );

      const inboxFiber = yield* kinInboxStream({}).pipe(
        Stream.runForEach((view) => Queue.offer(inboxViews, view)),
        provide,
        Effect.forkChild,
      );
      yield* Queue.offer(firstInbox, {
        _tag: "snapshot",
        chats: [summary("c1"), summary("c2")],
        waiting: [],
      } as unknown as KinChatListEvent);
      expect((yield* Queue.take(inboxViews)).value.chats.map((c) => c.chatId)).toEqual([
        "c1",
        "c2",
      ]);

      const readHistory = (input: KinChatHistoryInput) =>
        Queue.offer(historyReads, input).pipe(
          Effect.as({ messages: [message(2, "edited offline")], widgets: [], hasMore: false }),
        );
      const chatFiber = yield* makeKinChatStream(readHistory)({ chatId }).pipe(
        Stream.runForEach((view) => Queue.offer(chatViews, view)),
        provide,
        Effect.forkChild,
      );

      const cachedView = yield* Queue.take(chatViews);
      expect(cachedView).toMatchObject({ live: false, savedAt: "cached-at" });
      expect(cachedView.value.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(yield* Queue.take(subscribed)).toEqual({ chatId, afterSeq: 2 });

      yield* Queue.offer(firstChat, {
        _tag: "backlog",
        messages: [message(3)],
        widgets: [],
        lastSeq: 3,
      } as unknown as KinChatStreamEvent);
      expect((yield* Queue.take(chatViews)).value.contiguousSeq).toBe(3);
      expect(yield* Queue.take(historyReads)).toEqual({ chatId, beforeSeq: 4, limit: 50 });
      const reread = yield* Queue.take(chatViews);
      expect(reread.value.messages.map((m) => m.body)).toEqual([
        "message 1",
        "edited offline",
        "message 3",
      ]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondChat, Stream.never)));
      expect(yield* Queue.take(subscribed)).toEqual({ chatId, afterSeq: 3 });

      yield* Queue.offer(secondChat, leftEvent);
      expect((yield* Queue.take(chatViews)).value.left).toBe(true);
      yield* Fiber.join(chatFiber);
      expect(rows.has(`kin|${chatRowKey}`)).toBe(false);

      expect((yield* Queue.take(inboxViews)).value.chats.map((c) => c.chatId)).toEqual(["c2"]);
      yield* Fiber.interrupt(inboxFiber);
    }),
  );
});
