import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
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
import { KinChatHub, type KinChatHubEvent } from "../chat/KinChatHub.ts";
import * as Dispatch from "./KinPushDispatch.ts";
import { KinPushSender, type KinPushNotification } from "./KinPushSender.ts";

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

const presence = (on: boolean): KinChatHubEvent => ({
  type: "presence.updated",
  orgId,
  chatId,
  agentId,
  presence: on
    ? { agentId, wakeupId: null, state: "working", label: null, startedAt: T, since: T }
    : null,
});

it.effect("a card a turn posts is announced after the turn, with the turn's words", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<KinChatHubEvent>();
    const asked = yield* Queue.unbounded<KinPushNotification>();
    const keyChanges = yield* PubSub.unbounded<void>();
    const layer = Dispatch.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(KinChatHub)({ subscribeAll: Effect.succeed(Stream.fromQueue(events)) }),
          Layer.mock(ApproverKeys)({ changes: PubSub.subscribe(keyChanges) }),
          Layer.mock(KinPushSender)({
            status: "ready",
            flushKeyPushes: Effect.succeed(0),
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
