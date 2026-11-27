import { assert, it } from "@effect/vitest";
import {
  KinActionId,
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  KinWidgetId,
  ThreadId,
  type KinMessage,
  type KinWidget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ApproverKeys } from "../approvals/ApproverKeys.ts";
import { KinPendingActions, type ActionRef } from "../approvals/PendingActions.ts";
import { KinChatHub, type KinChatHubEvent } from "../chat/KinChatHub.ts";
import * as Dispatch from "./KinPushDispatch.ts";
import { KinPushSender, type KinPushNotification } from "./KinPushSender.ts";
import type { KinPushSettled } from "./KinPushTopics.ts";

const orgId = KinOrgId.make("org_01");
const chatId = KinChatId.make("chat_dm");
const agentId = KinAgentId.make("lead_tech");
const owner = KinPersonId.make("h_owner");
const T = "2026-11-08T00:00:00.000Z";

const said = (messageId: string): KinMessage => ({
  orgId,
  chatId,
  messageId: KinMessageId.make(messageId),
  seq: 1,
  author: {
    _tag: "agent",
    agentId,
    memberId: KinMemberId.make("m_tech"),
    ownerPersonId: owner,
    threadId: ThreadId.make("thread-tech"),
  },
  authorRole: "member",
  kind: "text",
  body: "",
  intent: null,
  mentions: [],
  replyTo: null,
  widgetId: null,
  floorRunId: null,
  status: "posted",
  sentBy: null,
  createdAt: T,
  editedAt: null,
});

const card = (messageId: string): KinWidget => ({
  orgId,
  chatId,
  widgetId: KinWidgetId.make(`choice:${messageId}`),
  messageId: KinMessageId.make(messageId),
  widgetClass: "native",
  type: "choice",
  revision: 1,
  state: { question: "Merge PR #87 once CI passes?" },
  source: null,
  feed: null,
  awaiting: [owner],
  pinnedAt: null,
  closedAt: null,
  updatedAt: T,
});

const presence = (on: boolean, wakeupId: string | null = null): KinChatHubEvent => ({
  type: "presence.updated",
  orgId,
  chatId,
  agentId,
  presence: on
    ? {
        agentId,
        wakeupId: wakeupId === null ? null : KinWakeupId.make(wakeupId),
        state: "working",
        label: null,
        startedAt: T,
        since: T,
      }
    : null,
});

/** The dispatcher on a hub fed from `events`, asking a sender that records into `asked`. */
const dispatching = Effect.gen(function* () {
  const events = yield* Queue.unbounded<KinChatHubEvent>();
  const asked = yield* Queue.unbounded<KinPushNotification>();
  const keyChanges = yield* PubSub.unbounded<void>();
  const actionChanges = yield* PubSub.unbounded<ActionRef>();
  const settled = yield* Queue.unbounded<KinPushSettled>();
  const layer = Dispatch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(KinChatHub)({ subscribeAll: Effect.succeed(Stream.fromQueue(events)) }),
        Layer.mock(ApproverKeys)({ changes: PubSub.subscribe(keyChanges) }),
        Layer.mock(KinPendingActions)({ changes: PubSub.subscribe(actionChanges) }),
        Layer.mock(KinPushSender)({
          status: "ready",
          statusFor: () => "ready",
          flushKeyPushes: Effect.succeed(0),
          settle: (_, what) => Queue.offer(settled, what).pipe(Effect.asVoid),
          notify: (notification) =>
            Queue.offer(asked, notification).pipe(
              Effect.andThen(
                Effect.forkChild(
                  Effect.succeed({ status: "ready", sent: 0, suppressed: 0, failed: 0 } as const),
                ),
              ),
            ),
        }),
      ),
    ),
  );
  return { events, asked, settled, actionChanges, layer };
});

it.effect("a turn's card is sent when its turn ends, though its line went on to the next", () =>
  Effect.gen(function* () {
    const { events, asked, layer } = yield* dispatching;
    yield* Effect.gen(function* () {
      // The late task's turn asks, and its line passes straight to the next wake-up's.
      for (const event of [
        presence(true, "wk_late"),
        { type: "message.posted", orgId, message: said("msg_card") },
        { type: "widget.updated", orgId, widget: card("msg_card") },
        presence(true, "wk_plan"),
        { type: "message.posted", orgId, message: said("msg_plan") },
        presence(false),
      ] satisfies ReadonlyArray<KinChatHubEvent>)
        yield* Queue.offer(events, event);
      const got = [];
      for (let index = 0; index < 3; index++) got.push(yield* Queue.take(asked));
      assert.deepStrictEqual(got, [
        { _tag: "message", orgId, messageId: KinMessageId.make("msg_card") },
        // Covered by its own turn's words only: the plan's reply says nothing of it.
        {
          _tag: "widget",
          orgId,
          widgetId: KinWidgetId.make("choice:msg_card"),
          covered: [KinMessageId.make("msg_card")],
        },
        { _tag: "message", orgId, messageId: KinMessageId.make("msg_plan") },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a card a turn posts is announced after the turn, with the turn's words", () =>
  Effect.gen(function* () {
    const { events, asked, layer } = yield* dispatching;
    yield* Effect.gen(function* () {
      // The lead's turn posts a question card, then its reply; the card waits for the reply.
      for (const event of [
        presence(true),
        { type: "message.posted", orgId, message: said("msg_card") },
        { type: "widget.updated", orgId, widget: card("msg_card") },
        { type: "message.posted", orgId, message: said("msg_reply") },
        presence(false),
        // Outside a turn, a card is announced as it comes.
        { type: "message.posted", orgId, message: said("msg_later") },
        { type: "widget.updated", orgId, widget: card("msg_later") },
      ] satisfies ReadonlyArray<KinChatHubEvent>)
        yield* Queue.offer(events, event);
      const got = [];
      for (let index = 0; index < 5; index++) got.push(yield* Queue.take(asked));
      assert.deepStrictEqual(got, [
        { _tag: "message", orgId, messageId: KinMessageId.make("msg_card") },
        { _tag: "message", orgId, messageId: KinMessageId.make("msg_reply") },
        {
          _tag: "widget",
          orgId,
          widgetId: KinWidgetId.make("choice:msg_card"),
          covered: [KinMessageId.make("msg_card"), KinMessageId.make("msg_reply")],
        },
        { _tag: "message", orgId, messageId: KinMessageId.make("msg_later") },
        { _tag: "widget", orgId, widgetId: KinWidgetId.make("choice:msg_later") },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a trouble card rings once, by its message: its count going up rings no one", () =>
  Effect.gen(function* () {
    const { events, asked, layer } = yield* dispatching;
    const trouble = (revision: number, count: number): KinWidget => ({
      ...card("msg_trouble"),
      widgetId: KinWidgetId.make("kin-trouble:org_01:space:1"),
      type: "host_trouble",
      revision,
      state: { cause: "space", count },
      awaiting: [],
    });
    yield* Effect.gen(function* () {
      for (const event of [
        { type: "message.posted", orgId, message: said("msg_trouble") },
        { type: "widget.updated", orgId, widget: trouble(1, 1) },
        { type: "widget.updated", orgId, widget: trouble(2, 5) },
        { type: "widget.updated", orgId, widget: trouble(3, 10) },
        { type: "message.posted", orgId, message: said("msg_after") },
      ] satisfies ReadonlyArray<KinChatHubEvent>)
        yield* Queue.offer(events, event);
      const got = [yield* Queue.take(asked), yield* Queue.take(asked)];
      assert.deepStrictEqual(got, [
        { _tag: "message", orgId, messageId: KinMessageId.make("msg_trouble") },
        { _tag: "message", orgId, messageId: KinMessageId.make("msg_after") },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("each commit that settles something asks to withdraw just what it settled", () =>
  Effect.gen(function* () {
    const { events, settled, actionChanges, layer } = yield* dispatching;
    yield* Effect.gen(function* () {
      const member = {
        orgId,
        chatId,
        memberId: KinMemberId.make("m_owner"),
        principal: { _tag: "person", personId: owner },
        role: "member",
        joinedAt: T,
        leftAt: T,
        mutedUntil: null,
      } as const;
      for (const event of [
        { type: "widget.updated", orgId, widget: card("msg_card") },
        // A redraw still waiting on her settles nothing; her answer does.
        { type: "widget.updated", orgId, widget: { ...card("msg_card"), revision: 2 } },
        { type: "widget.updated", orgId, widget: { ...card("msg_card"), awaiting: [] } },
        { type: "chat.cleared", orgId, chatId, lastSeq: 9, lastChangeSeq: 9 },
        { type: "member.removed", orgId, member },
        // An edit, still posted, settles nothing; a deletion does.
        { type: "message.changed", orgId, message: said("msg_edited") },
        { type: "message.changed", orgId, message: { ...said("msg_gone"), status: "deleted" } },
      ] satisfies ReadonlyArray<KinChatHubEvent>)
        yield* Queue.offer(events, event);
      const got = [];
      for (let index = 0; index < 4; index++) got.push(yield* Queue.take(settled));
      yield* PubSub.publish(actionChanges, { orgId, actionId: KinActionId.make("act-1") });
      got.push(yield* Queue.take(settled));
      assert.deepStrictEqual(got, [
        { topics: ["w:choice:msg_card"], messageIds: [KinMessageId.make("msg_card")] },
        { chatId, topics: ["c:chat_dm"] },
        { chatId, topics: ["c:chat_dm"], personId: owner },
        { messageIds: [KinMessageId.make("msg_gone")], topics: ["c:chat_dm"] },
        { topics: ["a:act-1"] },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);
