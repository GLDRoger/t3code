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
  KinChatError,
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
import * as TestClock from "effect/testing/TestClock";

import { MobileDatabase } from "../../../persistence/mobile-database";
import { KinChatState, type KinInboxState } from "./kinInboxModel";
import {
  isKinRetryable,
  KIN_CHAT_LABEL,
  kinInboxStream,
  makeKinChatStream,
  retryKinProbe,
  type KinSynced,
} from "./kinStreams";

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
  readonly chat: (input: KinChatSubscribeInput) => Stream.Stream<KinChatStreamEvent, KinChatError>;
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

const provider = Effect.fnUntraced(function* (
  activeSession: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession>>,
  rows: Map<string, string>,
) {
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
  return <A, E>(
    effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor | MobileDatabase>,
  ) =>
    effect.pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(MobileDatabase, fakeDatabase(rows)),
    );
});

const kinError = (reason: KinChatError["reason"]) => new KinChatError({ reason, message: reason });

describe("Kin streams", () => {
  it.each([
    ["unavailable", true],
    ["not_found", false],
    ["not_allowed", false],
    ["invalid_state", false],
    ["limit", false],
    ["widget_changed", false],
  ] as const)("retries a %s Kin error: %s", (reason, retryable) => {
    expect(isKinRetryable(kinError(reason))).toBe(retryable);
  });

  it.effect(
    "backs off 1 s doubling to 30 s, starts over once events flow, and ends on a refusal",
    () =>
      Effect.gen(function* () {
        const subscribed = yield* Queue.unbounded<KinChatSubscribeInput>();
        const backlogThrough = (seq: number, lastChangeSeq: number) =>
          Stream.make({
            _tag: "backlog",
            messages: [message(seq)],
            widgets: [],
            lastSeq: seq,
            lastChangeSeq,
          } as unknown as KinChatStreamEvent);
        const replies = [
          ...Array.from({ length: 6 }, () => Stream.fail(kinError("unavailable"))),
          backlogThrough(1, 4).pipe(Stream.concat(Stream.fail(kinError("unavailable")))),
          backlogThrough(2, 5).pipe(Stream.concat(Stream.fail(kinError("limit")))),
        ];
        const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
          Option.some(
            fakeSession({
              chat: (input) =>
                Stream.fromEffect(Queue.offer(subscribed, input)).pipe(
                  Stream.drain,
                  Stream.concat(replies.shift() ?? Stream.never),
                ),
              inbox: Stream.never,
            }),
          ),
        );
        const provide = yield* provider(activeSession, new Map());
        const views = yield* Queue.unbounded<KinSynced<KinChatState>>();
        const fiber = yield* makeKinChatStream(() => Effect.never)({ chatId }).pipe(
          Stream.runForEach((view) => Queue.offer(views, view)),
          provide,
          Effect.forkChild,
        );
        const resubscribesAfter = (seconds: number) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(seconds * 1000 - 1);
            expect(yield* Queue.size(subscribed)).toBe(0);
            yield* TestClock.adjust(1);
            return yield* Queue.take(subscribed);
          });

        expect(yield* Queue.take(subscribed)).toEqual({ chatId });
        for (const seconds of [1, 2, 4, 8, 16, 30]) {
          expect(yield* resubscribesAfter(seconds)).toEqual({ chatId });
        }
        expect((yield* Queue.take(views)).value).toMatchObject({ contiguousSeq: 1, changeSeq: 4 });
        // Events flowed, so the next outage waits 1 s again.
        expect(yield* resubscribesAfter(1)).toEqual({ chatId, afterSeq: 1, afterChangeSeq: 4 });
        expect((yield* Queue.take(views)).value).toMatchObject({ contiguousSeq: 2, changeSeq: 5 });
        expect((yield* Queue.take(views)).value.closed).toBe("limit");
        yield* Fiber.join(fiber);
        expect(yield* Queue.size(subscribed)).toBe(0);
      }),
  );

  it.effect("resubscribes as soon as a new session comes up during a backoff", () =>
    Effect.gen(function* () {
      const subscribed = yield* Queue.unbounded<KinChatSubscribeInput>();
      const session = (reply: Stream.Stream<KinChatStreamEvent, KinChatError>) =>
        fakeSession({
          chat: (input) =>
            Stream.fromEffect(Queue.offer(subscribed, input)).pipe(
              Stream.drain,
              Stream.concat(reply),
            ),
          inbox: Stream.never,
        });
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some(session(Stream.fail(kinError("unavailable")))),
      );
      const provide = yield* provider(activeSession, new Map());
      const fiber = yield* makeKinChatStream(() => Effect.never)({ chatId }).pipe(
        Stream.runDrain,
        provide,
        Effect.forkChild,
      );
      expect(yield* Queue.take(subscribed)).toEqual({ chatId });
      yield* TestClock.adjust(1000);
      expect(yield* Queue.take(subscribed)).toEqual({ chatId });
      // Now in the 2 s wait; the host comes back on a new session without the clock moving.
      yield* SubscriptionRef.set(activeSession, Option.some(session(Stream.never)));
      expect(yield* Queue.take(subscribed)).toEqual({ chatId });
      yield* TestClock.adjust(30_000);
      expect(yield* Queue.size(subscribed)).toBe(0);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect.each([
    ["not_found", false],
    ["not_allowed", false],
    ["limit", true],
    ["invalid_state", true],
  ] as const)("on a %s refusal keeps the cached chat: %s", ([reason, kept]) =>
    Effect.gen(function* () {
      const rows = new Map<string, string>();
      rows.set(
        `kin|${chatRowKey}`,
        encodeCachedChat({
          chat: {
            messages: [message(1)],
            widgets: [],
            contiguousSeq: 1,
            changeSeq: 0,
            reads: {},
            needsHistoryReload: false,
            left: false,
            closed: null,
          },
          savedAt: "cached-at",
        }),
      );
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some(
          fakeSession({ chat: () => Stream.fail(kinError(reason)), inbox: Stream.never }),
        ),
      );
      const provide = yield* provider(activeSession, rows);
      const views = yield* makeKinChatStream(() => Effect.never)({ chatId }).pipe(
        Stream.runCollect,
        provide,
      );
      expect(views.at(-1)?.value.closed).toBe(reason);
      expect(rows.has(`kin|${chatRowKey}`)).toBe(kept);
    }),
  );

  it.effect("re-probes a known Kin host through unavailable, and fails at once for others", () =>
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<number>();
      let calls = 0;
      const probe = Effect.suspend(() => {
        calls += 1;
        return Queue.offer(attempts, calls).pipe(
          Effect.andThen(
            calls <= 2 ? Effect.fail(kinError("unavailable")) : Effect.succeed("orgs" as const),
          ),
        );
      });
      const known = yield* retryKinProbe(probe, () => true).pipe(Effect.forkChild);
      expect(yield* Queue.take(attempts)).toBe(1);
      yield* TestClock.adjust(1000);
      expect(yield* Queue.take(attempts)).toBe(2);
      yield* TestClock.adjust(1999);
      expect(yield* Queue.size(attempts)).toBe(0);
      yield* TestClock.adjust(1);
      expect(yield* Queue.take(attempts)).toBe(3);
      expect(yield* Fiber.join(known)).toBe("orgs");

      calls = 0;
      const unknown = yield* retryKinProbe(probe, () => false).pipe(Effect.flip);
      expect(unknown.reason).toBe("unavailable");
      expect(calls).toBe(1);
    }),
  );

  it.effect("resumes from both cursors across sessions and drops a left chat", () =>
    Effect.gen(function* () {
      const rows = new Map<string, string>();
      rows.set(
        `kin|${chatRowKey}`,
        encodeCachedChat({
          chat: {
            messages: [message(1), message(2)],
            widgets: [],
            contiguousSeq: 2,
            changeSeq: 7,
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
      const provide = yield* provider(activeSession, rows);

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
      expect(yield* Queue.take(subscribed)).toEqual({ chatId, afterSeq: 2, afterChangeSeq: 7 });

      // The backlog carries the offline edit itself; no history page is re-read for it.
      yield* Queue.offer(firstChat, {
        _tag: "backlog",
        messages: [message(2, "edited offline"), message(3)],
        widgets: [],
        lastSeq: 3,
        lastChangeSeq: 11,
      } as unknown as KinChatStreamEvent);
      const resumed = (yield* Queue.take(chatViews)).value;
      expect(resumed).toMatchObject({ contiguousSeq: 3, changeSeq: 11 });
      expect(resumed.messages.map((m) => m.body)).toEqual([
        "message 1",
        "edited offline",
        "message 3",
      ]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondChat, Stream.never)));
      expect(yield* Queue.take(subscribed)).toEqual({ chatId, afterSeq: 3, afterChangeSeq: 11 });
      expect(yield* Queue.size(historyReads)).toBe(0);

      yield* Queue.offer(secondChat, leftEvent);
      expect((yield* Queue.take(chatViews)).value.left).toBe(true);
      yield* Fiber.join(chatFiber);
      expect(rows.has(`kin|${chatRowKey}`)).toBe(false);

      expect((yield* Queue.take(inboxViews)).value.chats.map((c) => c.chatId)).toEqual(["c2"]);
      yield* Fiber.interrupt(inboxFiber);
    }),
  );
});
