import { assert, it } from "@effect/vitest";
import {
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinScheduledTaskCard,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Chat from "../chat/KinChatService.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Budget from "../lead/KinBudget.ts";
import * as LeadDelivery from "../lead/LeadDelivery.ts";
import { leadWakeup } from "../lead/LeadDelivery.testkit.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as TriggerScheduler from "./KinTriggerScheduler.ts";
import * as TriggerService from "./KinTriggerService.ts";
import { fixture, item, orgId, seed } from "./routines.testkit.ts";
import * as ScheduledTasks from "./scheduledTasks.ts";

const decodeCard = Schema.decodeUnknownSync(KinScheduledTaskCard);
const task: MemoryItemHead = item("sch-prs", {
  kind: "deferral",
  path: "deferrals/sch-prs.md",
  title: "Open PRs digest",
  what: "List the open PRs on acme/api and who is blocking each one.",
  every: { at: "08:00", days: [1, 2, 3, 4, 5] },
  chat: KinChatId.make("chat-a"),
  links: [],
});
// Mon 9 Nov 14:30 in Kolkata; the next weekday 8:00 there is Tue 10 Nov, 02:30 UTC.
const start = Date.parse("2026-11-09T09:00:00.000Z");
const tuesday = Date.parse("2026-11-10T02:30:00.000Z");
const wednesday = Date.parse("2026-11-11T02:30:00.000Z");
const owner = { _tag: "person", orgId, personId: KinPersonId.make("owner-a") } as const;

const layer = ScheduledTasks.layer.pipe(
  Layer.provideMerge(TriggerService.layer),
  Layer.provideMerge(LeadDelivery.layer),
  Layer.provideMerge(Budget.layer.pipe(Layer.provide(MemoryCache.layer))),
  Layer.provideMerge(fixture([task])),
);

const setup = Effect.fn("test.scheduledSetup")(function* () {
  yield* seed();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:30', '18:30', '03:00', 0, 1, '09:00', '{"from":"21:00","to":"08:00"}')`;
  yield* TestClock.setTime(start);
  yield* (yield* TriggerService.KinTriggerService).syncItem(task);
});

const tick = Effect.fn("test.scheduledTick")(function* (at: number) {
  yield* TestClock.setTime(at);
  yield* (yield* TriggerScheduler.KinTriggerScheduler).runDue();
  yield* (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
});

const card = Effect.fn("test.scheduledCard")(function* () {
  const repo = yield* Repository.KinChatRepository;
  const widgetId = ScheduledTasks.scheduledTaskWidgetId(orgId, "sch-prs");
  const widget = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId }));
  return { widget, state: decodeCard(widget.state) };
});

const runs = Effect.fn("test.scheduledRuns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ eventId: string; agentId: string; itemId: string }>`SELECT
      event_id AS "eventId", agent_id AS "agentId",
      json_extract(json, '$.subject.itemId') AS "itemId"
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'deferral.due'
      AND json_extract(json, '$.subject.type') = 'scheduled_task' ORDER BY received_at, event_id`;
});

it.effect("a scheduled task wakes the lead at its time and its card records the run", () =>
  Effect.gen(function* () {
    yield* setup();
    const before = yield* card();
    assert.equal(before.widget.chatId, "chat-a");
    assert.include(before.state, { status: "active", nextRunAt: "2026-11-10T02:30:00.000Z" });
    assert.isNull(before.state.lastRun);

    yield* tick(tuesday - 60_000);
    assert.lengthOf(yield* runs(), 0);
    yield* tick(tuesday);
    const [run] = yield* runs();
    assert.include(run, { agentId: "lead-a", itemId: "sch-prs" });
    assert.equal((yield* card()).state.lastRun?.status, "running");

    const messageId = yield* leadWakeup({
      orgId,
      eventId: run!.eventId,
      chatId: "chat-a",
      body: "Three PRs are open on acme/api. #41 waits on Bob's review.",
    });
    yield* (yield* LeadDelivery.KinLeadDelivery).settle(orgId);
    const after = (yield* card()).state;
    assert.deepEqual(after.lastRun, {
      at: "2026-11-10T02:30:00.000Z",
      status: "posted",
      note: "Three PRs are open on acme/api. #41 waits on Bob's review.",
      messageId: KinMessageId.make(messageId!),
    });
    assert.equal(after.nextRunAt, "2026-11-11T02:30:00.000Z");

    // The next run finds nothing worth telling: the lead ends its turn without a message.
    yield* tick(wednesday);
    const [, quiet] = yield* runs();
    yield* leadWakeup({ orgId, eventId: quiet!.eventId, chatId: "chat-a" });
    yield* (yield* LeadDelivery.KinLeadDelivery).settle(orgId);
    assert.deepEqual((yield* card()).state.lastRun, {
      at: "2026-11-11T02:30:00.000Z",
      status: "skipped",
      note: "nothing to report.",
    });
    const sql = yield* SqlClient.SqlClient;
    const said = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${orgId} AND chat_id = 'chat-a' AND created_at > ${after.lastRun!.at}
      ORDER BY seq`;
    assert.deepStrictEqual(
      said.map((row) => row.body),
      ["Three PRs are open on acme/api. #41 waits on Bob's review."],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("Pause stops scheduled runs until Resume", () =>
  Effect.gen(function* () {
    yield* setup();
    const chat = yield* Chat.KinChatService;
    const tap = Effect.fn("test.scheduledTap")(function* (actionId: string) {
      const { widget } = yield* card();
      return yield* chat.act(owner, {
        widgetId: widget.widgetId,
        revision: widget.revision,
        actionId,
        value: "sch-prs",
        clientActionId: `${actionId}-sch-prs`,
      });
    });

    yield* tap("pause");
    assert.include((yield* card()).state, { status: "paused", nextRunAt: null });
    yield* tick(tuesday);
    yield* tick(wednesday);
    assert.lengthOf(yield* runs(), 0);

    yield* tap("resume");
    const resumed = (yield* card()).state;
    assert.include(resumed, { status: "active", nextRunAt: "2026-11-12T02:30:00.000Z" });
    yield* tick(Date.parse(resumed.nextRunAt!));
    assert.lengthOf(yield* runs(), 1);
  }).pipe(Effect.provide(layer)),
);
