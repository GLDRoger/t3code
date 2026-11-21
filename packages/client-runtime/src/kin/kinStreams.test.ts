import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/index.ts";
import type { RpcSession } from "../rpc/index.ts";
import { EnvironmentQueryStore } from "../state/queryPersistence.ts";
import { queryPersistenceKey } from "../state/runtime.ts";
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
  type KinPulseEvent,
  type KinPulseFact,
  type KinPulseSubscribeInput,
  type KinWaitingItem,
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

import { KinChatState, KinInboxState } from "./kinInboxModel.ts";
import { kinPulseLiveStream } from "./kinPulseStream.ts";
import {
  isKinRetryable,
  KIN_CHAT_LABEL,
  KIN_INBOX_LABEL,
  KinCacheEviction,
  kinInboxStream,
  makeKinChatStream,
  retryKinProbe,
  type KinSynced,
} from "./kinStreams.ts";

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

const chatRowKey = queryPersistenceKey(KIN_CHAT_LABEL, { chatId });
const CachedChat = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Struct({ chat: KinChatState, savedAt: Schema.String })),
);
const encodeCachedChat = Schema.encodeSync(CachedChat);
const decodeCachedChat = Schema.decodeSync(CachedChat);
const inboxRowKey = queryPersistenceKey(KIN_INBOX_LABEL, {});
const CachedInbox = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Struct({ inbox: KinInboxState, savedAt: Schema.String })),
);
const encodeCachedInbox = Schema.encodeSync(CachedInbox);
const decodeCachedInbox = Schema.decodeSync(CachedInbox);

/** An in-memory device cache: rows keyed by query key, as a client's store would hold them. */
function fakeCache(rows: Map<string, string>) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(EnvironmentQueryStore, {
        load: (_environmentId, key) => Effect.sync(() => Option.fromNullishOr(rows.get(key))),
        save: (_environmentId, key, payload) => Effect.sync(() => void rows.set(key, payload)),
      }),
      Effect.provideService(KinCacheEviction, (_environmentId, key) =>
        Effect.sync(() => void rows.delete(key)),
      ),
    );
}

function fakeSession(streams: {
  readonly chat: (input: KinChatSubscribeInput) => Stream.Stream<KinChatStreamEvent, KinChatError>;
  readonly inbox: Stream.Stream<KinChatListEvent, KinChatError>;
  readonly pulse?: (input: KinPulseSubscribeInput) => Stream.Stream<KinPulseEvent, KinChatError>;
}): RpcSession {
  return {
    client: {
      [KIN_CHAT_WS_METHODS.chatSubscribe]: streams.chat,
      [KIN_CHAT_WS_METHODS.chatsSubscribe]: () => streams.inbox,
      "kin.pulse.subscribe": streams.pulse ?? (() => Stream.never),
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
  return <A, E>(effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>) =>
    effect.pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      fakeCache(rows),
    );
});

const kinError = (reason: KinChatError["reason"]) => new KinChatError({ reason, message: reason });

const fact = (key: string, title = key) =>
  ({
    sense: "task_late",
    family: "work",
    key,
    subject: { kind: "record", key: "W-1", title },
    scope: {},
    since: at,
    consequence: title,
    actor: { _tag: "owner" },
    sensitive: false,
    wake: "now",
    handled: null,
  }) as unknown as KinPulseFact;

describe("Kin streams", () => {
  it.effect(
    "Needs attention folds what moved, and a new session names the page held so nothing is resent",
    () =>
      Effect.gen(function* () {
        const subscribed = yield* Queue.unbounded<KinPulseSubscribeInput>();
        const asOf = at as unknown as Extract<KinPulseEvent, { _tag: "changed" }>["asOf"];
        const replies: Array<Stream.Stream<KinPulseEvent, KinChatError>> = [
          Stream.make<ReadonlyArray<KinPulseEvent>>(
            {
              _tag: "snapshot",
              read: { asOf, total: 2, facts: [fact("a"), fact("b")] },
              hash: "h1",
            },
            {
              _tag: "changed",
              asOf,
              total: 2,
              updated: [fact("b", "b moved"), fact("c")],
              removed: ["a"],
              hash: "h2",
            },
          ).pipe(Stream.concat(Stream.fail(kinError("unavailable")))),
          Stream.make<ReadonlyArray<KinPulseEvent>>(
            { _tag: "current", hash: "h2" },
            { _tag: "changed", asOf, total: 1, updated: [], removed: ["b"], hash: "h3" },
          ).pipe(Stream.concat(Stream.never)),
        ];
        const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
          Option.some(
            fakeSession({
              chat: () => Stream.never,
              inbox: Stream.never,
              pulse: (input) =>
                Stream.fromEffect(Queue.offer(subscribed, input)).pipe(
                  Stream.drain,
                  Stream.concat(replies.shift() ?? Stream.never),
                ),
            }),
          ),
        );
        const provide = yield* provider(activeSession, new Map());
        const pages = yield* Queue.unbounded<ReadonlyArray<string>>();
        yield* kinPulseLiveStream({ orgId: "org" as KinPulseSubscribeInput["orgId"] }).pipe(
          Stream.runForEach((read) =>
            Queue.offer(
              pages,
              read.facts.map((one) => `${one.key}:${one.subject.title}`),
            ),
          ),
          provide,
          Effect.forkChild,
        );
        expect(yield* Queue.take(subscribed)).toEqual({ orgId: "org" });
        expect(yield* Queue.take(pages)).toEqual(["a:a", "b:b"]);
        expect(yield* Queue.take(pages)).toEqual(["b:b moved", "c:c"]);
        yield* TestClock.adjust(1000);
        expect(yield* Queue.take(subscribed)).toEqual({ orgId: "org", held: "h2" });
        // `current` shows nothing new; the change after it applies to the page held.
        expect(yield* Queue.take(pages)).toEqual(["c:c"]);
      }),
  );

  it.each([
    ["unavailable", true],
    ["disabled", false],
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
    ["disabled", true],
    ["limit", true],
    ["invalid_state", true],
  ] as const)("on a %s refusal keeps the cached chat: %s", ([reason, kept]) =>
    Effect.gen(function* () {
      const rows = new Map<string, string>();
      rows.set(
        chatRowKey,
        encodeCachedChat({
          chat: {
            messages: [message(1)],
            widgets: [],
            reactions: [],
            contiguousSeq: 1,
            changeSeq: 0,
            reads: {},
            memberChanges: 0,
            drafts: [],
            presence: [],
            needsHistoryReload: false,
            clearedSeq: 0,
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
      // `disabled` waits for Kin to come back instead of ending.
      const views = yield* makeKinChatStream(() => Effect.never)({ chatId }).pipe(
        Stream.takeUntil((view) => view.value.closed !== null),
        Stream.runCollect,
        provide,
      );
      expect(views.at(-1)?.value.closed).toBe(reason);
      expect(rows.has(chatRowKey)).toBe(kept);
    }),
  );

  it.effect("waits out Kin turned off and resubscribes both streams on the next session", () =>
    Effect.gen(function* () {
      const subscribed = yield* Queue.unbounded<KinChatSubscribeInput>();
      const chatViews = yield* Queue.unbounded<KinSynced<KinChatState>>();
      const inboxViews = yield* Queue.unbounded<KinSynced<KinInboxState>>();
      // Kin turns off after the chat has gone live.
      const kinOff = fakeSession({
        chat: (input) =>
          Stream.fromEffect(Queue.offer(subscribed, input)).pipe(
            Stream.drain,
            Stream.concat(
              Stream.make({
                _tag: "backlog",
                messages: [message(1)],
                widgets: [],
                lastSeq: 1,
                lastChangeSeq: 3,
              } as unknown as KinChatStreamEvent),
            ),
            Stream.concat(Stream.fail(kinError("disabled"))),
          ),
        inbox: Stream.fail(kinError("disabled")),
      });
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some(kinOff),
      );
      const provide = yield* provider(activeSession, new Map());
      const chatFiber = yield* makeKinChatStream(() => Effect.never)({ chatId }).pipe(
        Stream.runForEach((view) => Queue.offer(chatViews, view)),
        provide,
        Effect.forkChild,
      );
      const inboxFiber = yield* kinInboxStream({}).pipe(
        Stream.runForEach((view) => Queue.offer(inboxViews, view)),
        provide,
        Effect.forkChild,
      );
      expect(yield* Queue.take(subscribed)).toEqual({ chatId });
      expect((yield* Queue.take(chatViews)).value.contiguousSeq).toBe(1);
      expect((yield* Queue.take(chatViews)).value.closed).toBe("disabled");

      // The host goes down: its turned-off answer goes with it, and the feed shows as cached.
      yield* SubscriptionRef.set(activeSession, Option.none());
      expect(yield* Queue.take(chatViews)).toMatchObject({
        live: false,
        value: { closed: null, contiguousSeq: 1 },
      });

      // The host restarts with Kin: a backlog that changes nothing still reopens the chat.
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          fakeSession({
            chat: (input) =>
              Stream.fromEffect(Queue.offer(subscribed, input)).pipe(
                Stream.drain,
                Stream.concat(
                  Stream.make({
                    _tag: "backlog",
                    messages: [],
                    widgets: [],
                    lastSeq: 1,
                    lastChangeSeq: 3,
                  } as unknown as KinChatStreamEvent),
                ),
                // Without a reopen view for the backlog, this message's view would come first.
                Stream.concat(
                  Stream.make({ _tag: "message", message: message(2) } as KinChatStreamEvent),
                ),
                Stream.concat(Stream.never),
              ),
            inbox: Stream.make({
              _tag: "snapshot",
              chats: [summary("c1")],
              waiting: [],
            } as unknown as KinChatListEvent).pipe(Stream.concat(Stream.never)),
          }),
        ),
      );
      expect(yield* Queue.take(subscribed)).toEqual({ chatId, afterSeq: 1, afterChangeSeq: 3 });
      expect(yield* Queue.take(chatViews)).toMatchObject({
        live: true,
        value: { closed: null, contiguousSeq: 1 },
      });
      expect((yield* Queue.take(chatViews)).value.contiguousSeq).toBe(2);
      expect((yield* Queue.take(inboxViews)).value.chats.map((c) => c.chatId)).toEqual(["c1"]);
      yield* Fiber.interrupt(chatFiber);
      yield* Fiber.interrupt(inboxFiber);
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

      // `disabled` is final even on a known host.
      const off = yield* retryKinProbe(
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(kinError("disabled"));
        }),
        () => true,
      ).pipe(Effect.flip);
      expect(off.reason).toBe("disabled");
      expect(calls).toBe(2);
    }),
  );

  it.effect("resumes from both cursors across sessions and drops a left chat", () =>
    Effect.gen(function* () {
      const rows = new Map<string, string>();
      rows.set(
        chatRowKey,
        encodeCachedChat({
          chat: {
            messages: [message(1), message(2)],
            widgets: [],
            reactions: [],
            contiguousSeq: 2,
            changeSeq: 7,
            drafts: [],
            presence: [],
            reads: {},
            memberChanges: 0,
            needsHistoryReload: false,
            clearedSeq: 0,
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
      expect(rows.has(chatRowKey)).toBe(false);

      expect((yield* Queue.take(inboxViews)).value.chats.map((c) => c.chatId)).toEqual(["c2"]);
      yield* Fiber.interrupt(inboxFiber);
    }),
  );
  it.effect("forgets a cleared chat's cached messages when it comes back to it", () =>
    Effect.gen(function* () {
      const cached = {
        messages: [message(1), message(2)],
        widgets: [],
        reactions: [],
        contiguousSeq: 2,
        changeSeq: 7,
        drafts: [],
        presence: [],
        reads: {},
        memberChanges: 0,
        needsHistoryReload: false,
        clearedSeq: 0,
        left: false,
        closed: null,
      };
      const rows = new Map([
        [chatRowKey, encodeCachedChat({ chat: cached, savedAt: "cached-at" })],
      ]);
      const events = yield* Queue.unbounded<KinChatStreamEvent>();
      const views = yield* Queue.unbounded<KinSynced<KinChatState>>();
      const provide = yield* provider(
        yield* SubscriptionRef.make<Option.Option<RpcSession>>(
          Option.some(fakeSession({ chat: () => Stream.fromQueue(events), inbox: Stream.never })),
        ),
        rows,
      );
      const fiber = yield* makeKinChatStream(() =>
        Effect.succeed({ messages: [], widgets: [], hasMore: false }),
      )({ chatId }).pipe(
        Stream.runForEach((view) => Queue.offer(views, view)),
        provide,
        Effect.forkChild,
      );
      expect((yield* Queue.take(views)).value.messages).toHaveLength(2);
      // Cleared while this device was away: the host answers its old cursor with a reset.
      yield* Queue.offer(events, { _tag: "reset", lastSeq: 2, lastChangeSeq: 9, cleared: true });
      expect((yield* Queue.take(views)).value).toMatchObject({ messages: [], changeSeq: 9 });
      expect((yield* Queue.take(views)).value.needsHistoryReload).toBe(false);
      // Closing the stream writes what it holds: the next open starts from the empty chat.
      yield* Fiber.interrupt(fiber);
      expect(decodeCachedChat(rows.get(chatRowKey) ?? "").chat).toMatchObject({
        messages: [],
        contiguousSeq: 2,
        changeSeq: 9,
      });
    }),
  );

  it.effect("never keeps what waits for someone else in the offline inbox", () =>
    Effect.gen(function* () {
      const row = (waitingId: string, personId: string) =>
        ({
          waitingId,
          orgId: "org",
          personId,
          chatId,
          messageId: null,
          widgetId: null,
          reason: "question",
          createdAt: at,
          resolvedAt: null,
          resolution: null,
        }) as KinWaitingItem;
      const own = row("w-own", "meera");
      const owners = {
        ...row("w-rhea", "rhea"),
        waitsFor: { personId: "rhea", name: "Rhea Rao" },
      } as KinWaitingItem;
      const ids = (inbox: KinInboxState) => inbox.waiting.map((item) => item.waitingId);
      // A cache an older build saved with the owner's row in it shows her own row only.
      const rows = new Map([
        [
          inboxRowKey,
          encodeCachedInbox({ inbox: { chats: [], waiting: [own, owners] }, savedAt: at }),
        ],
      ]);
      const inbox = yield* Queue.unbounded<KinChatListEvent>();
      const views = yield* Queue.unbounded<KinSynced<KinInboxState>>();
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some(fakeSession({ chat: () => Stream.never, inbox: Stream.fromQueue(inbox) })),
      );
      const provide = yield* provider(activeSession, rows);
      const fiber = yield* kinInboxStream({}).pipe(
        Stream.runForEach((view) => Queue.offer(views, view)),
        provide,
        Effect.forkChild,
      );
      const cached = yield* Queue.take(views);
      expect([cached.live, ids(cached.value)]).toEqual([false, ["w-own"]]);
      // Live, both show; what is saved keeps her own only.
      yield* Queue.offer(inbox, { _tag: "snapshot", chats: [], waiting: [own, owners] });
      expect(ids((yield* Queue.take(views)).value)).toEqual(["w-own", "w-rhea"]);
      yield* Fiber.interrupt(fiber);
      expect(ids(decodeCachedInbox(rows.get(inboxRowKey) ?? "").inbox)).toEqual(["w-own"]);
    }),
  );

  it.effect("reads the open chat again when the viewer's access moves, so a lost link goes", () =>
    Effect.gen(function* () {
      const linked = { ...message(1), links: [{ text: "INV-1" }] } as unknown as KinMessage;
      const events = yield* Queue.unbounded<KinChatStreamEvent>();
      const moves = yield* Queue.unbounded<string>();
      const views = yield* Queue.unbounded<KinSynced<KinChatState>>();
      let page = linked;
      const provide = yield* provider(
        yield* SubscriptionRef.make<Option.Option<RpcSession>>(
          Option.some(fakeSession({ chat: () => Stream.fromQueue(events), inbox: Stream.never })),
        ),
        new Map(),
      );
      yield* makeKinChatStream(
        () => Effect.sync(() => ({ messages: [page], widgets: [], hasMore: false })),
        () => Stream.fromQueue(moves),
      )({ chatId }).pipe(
        Stream.runForEach((view) => Queue.offer(views, view)),
        provide,
        Effect.forkChild,
      );
      // The revision held when the chat opens moves nothing.
      yield* Queue.offer(moves, "0");
      yield* Queue.offer(events, { _tag: "message", message: linked } as KinChatStreamEvent);
      expect((yield* Queue.take(views)).value.messages[0]?.links).toHaveLength(1);
      page = message(1);
      yield* Queue.offer(moves, "1");
      expect((yield* Queue.take(views)).value.messages[0]?.links).toBeUndefined();
    }),
  );
});
