import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Repository from "../chat/KinChatRepository.ts";
import * as Queue from "../lead/KinEventQueue.ts";
import * as MemoryWriter from "../memory/MemoryWriter.ts";
import * as Deferrals from "./deferrals.ts";
import * as TriggerService from "./KinTriggerService.ts";
import { fixture, item, orgId, otherOrg, seed } from "./routines.testkit.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeSync(KinEvent);
const deferral = item("def-1", {
  kind: "deferral",
  path: "deferrals/def-1.md",
  due: "2026-11-13T09:00+05:30",
  on_due: "start",
  chat: KinChatId.make("chat-a"),
});
const widgetId = KinWidgetId.make(`deferral:${orgId}:def-1`);

it.effect("applies verified owner taps on the confirm card and ignores forged ones", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* TestClock.setTime(Date.parse("2026-11-09T09:00:00.000Z"));
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* Repository.KinChatRepository;
    const queue = yield* Queue.KinEventQueue;
    const deferrals = yield* Deferrals.Deferrals;
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    const staged: MemoryWriter.MemoryChange[] = [];
    const writer = Layer.mock(MemoryWriter.MemoryWriter)({
      stage: (_org, _wakeup, change) => Effect.sync(() => void staged.push(change)),
    });
    const tapOnce = Effect.fn("test.deferralTap")(function* (actionId: string, label: string) {
      const memberId = "owner-member-a";
      // Stands in for the gated dispatcher: chat act refuses deferral taps today.
      const message = yield* repo.insertMessage({
        orgId,
        chatId: KinChatId.make("chat-a"),
        messageId: KinMessageId.make(`tap-${actionId}-${label}`),
        author: {
          _tag: "human",
          personId: KinPersonId.make("owner-a"),
          memberId: KinMemberId.make(memberId),
        },
        kind: "widget_action",
        body: encodeJson({ widgetId, revision: 1, actionId, value: "def-1" }),
        intent: null,
        mentions: [],
        replyTo: KinMessageId.make(widgetId),
        widgetId,
        floorRunId: null,
        status: "posted",
        sentBy: KinPersonId.make("owner-a"),
        clientMessageId: { kind: "act", id: `${actionId}-${label}` },
        createdAt: "2026-11-09T09:00:00.000Z",
        editedAt: null,
      });
      const eventId = `${actionId}-${label}`;
      yield* queue.enqueue(
        decodeEvent({
          _tag: "widget.action",
          orgId,
          eventId,
          agentId: "lead-a",
          receivedAt: "2026-11-09T09:00:00.000Z",
          dedupeKey: eventId,
          provenance: { _tag: "human", personId: "owner-a", memberId },
          chatId: "chat-a",
          messageId: message.messageId,
          actionId,
        }),
      );
      yield* TestClock.adjust("20 seconds");
      const wakeupId = KinWakeupId.make(`wake-${eventId}`);
      yield* queue.claim({ orgId, agentId: KinAgentId.make("lead-a"), wakeupId, model: "fixture" });
      if (label === "demoted")
        yield* sql`UPDATE kin_chat_members SET role = 'member' WHERE org_id = ${orgId} AND member_id = ${memberId}`;
      const result = yield* deferrals
        .act(orgId, wakeupId, KinEventId.make(eventId))
        .pipe(Effect.provide(writer), Effect.result);
      const forged = yield* deferrals
        .act(otherOrg, wakeupId, KinEventId.make(eventId))
        .pipe(Effect.provide(writer), Effect.flip);
      assert.equal(forged._tag, "DeferralError");
      yield* queue.finish({ orgId, wakeupId, status: "completed" });
      return result;
    });
    const tap = (actionId: string, label: string) => Effect.scoped(tapOnce(actionId, label));

    const remind = yield* tap("remind", "owner");
    assert.equal(remind._tag === "Success" && remind.success.action, "remind");
    assert.lengthOf(staged, 1);
    assert.equal(staged[0]?.sourceEventId, "remind-owner");
    assert.include(staged[0]!.content, "on_due: remind");

    const change = yield* tap("change", "owner");
    assert.equal(change._tag === "Success" && change.success.action, "change");
    assert.lengthOf(staged, 1);

    const member = yield* tap("remind", "demoted");
    assert.equal(member._tag, "Failure");
    assert.lengthOf(staged, 1);
  }).pipe(
    Effect.provide(
      Deferrals.layer.pipe(
        Layer.provideMerge(TriggerService.layer),
        Layer.provideMerge(fixture([deferral])),
      ),
    ),
  ),
);
