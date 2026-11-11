import { assert, it } from "@effect/vitest";
import {
  CommandId,
  KinChatId,
  ProjectId,
  ProviderInstanceId,
  KinMessageId,
  KinPersonId,
  KinScheduledTaskCard,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
import * as KinSchedules from "./kinSchedules.ts";
import { nativeScheduler } from "./kinSchedules.testkit.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { KinAgentId, KinMemoryItemId } from "@t3tools/contracts";

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

/** Kin's consumer over the real native scheduler; `recorded` holds what would be bare threads. */
const harness = () => {
  const recorded = {
    launches: [] as ThreadLaunchService.ThreadLaunchInput[],
    sends: [] as string[],
  };
  const workers = new Map<string, Effect.Effect<void>>();
  const layer = ScheduledTasks.layer.pipe(
    Layer.provideMerge(TriggerService.layer),
    Layer.provideMerge(LeadDelivery.layer),
    Layer.provideMerge(Budget.layer.pipe(Layer.provide(MemoryCache.layer))),
    Layer.provideMerge(nativeScheduler(orgId, "lead-a", recorded, workers)),
    Layer.provideMerge(fixture([task])),
  );
  return { recorded, workers, layer };
};
const layer = harness().layer;

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

// Native schedules: the task is T3's, its kin_schedules row the authority for each run.
const scheduleId = KinMemoryItemId.make("sch-native");
const taskId = KinSchedules.scheduleTaskId(orgId, scheduleId);
const MODELS = JSON.stringify({
  strong: { instanceId: "claude", model: "invented-strong" },
  cheap: { instanceId: "claude", model: "invented-cheap" },
});
const prompt = "Check the open PRs on acme/app and say which are stuck.";

/** The owner's own message in `chatId`, in a turn only the owner read, and a schedule from it. */
const nativeSetup = Effect.fn("test.nativeSetup")(function* (chatId = "chat-a") {
  yield* setup();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_leads SET models_json = ${MODELS} WHERE org_id = ${orgId}`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
      event_ids, audience) VALUES ('set-wake', ${orgId}, 'lead-a', 'test', 0, 'completed',
      '["set-event"]', 'owner_only')`;
  const asked = {
    _tag: "chat.message",
    orgId,
    agentId: "lead-a",
    eventId: "set-event",
    receivedAt: "2026-11-09T09:00:00.000Z",
    dedupeKey: null,
    provenance: { _tag: "human", personId: "owner-a", memberId: "owner-member-a" },
    chatId,
    messageId: "set-message",
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES ('set-event', ${orgId}, 'lead-a', 'chat.message', 'P0', ${JSON.stringify(asked)}, 0, 0,
      'done', 'set-wake')`;
  yield* save({ chatId });
});

const save = Effect.fn("test.nativeSave")(function* (
  overrides: {
    readonly chatId?: string;
    readonly prompt?: string;
    readonly existing?: boolean;
  } = {},
) {
  yield* (yield* KinSchedules.KinSchedules).save({
    orgId,
    agentId: KinAgentId.make("lead-a"),
    scheduleId,
    existing: overrides.existing ?? false,
    chatId: KinChatId.make(overrides.chatId ?? "chat-a"),
    sourceEvent: "set-event",
    saidBy: "owner-a",
    title: "Stuck PRs",
    prompt: overrides.prompt ?? prompt,
    every: { at: "09:00", days: [1, 2, 3, 4, 5] },
    now: yield* Clock.currentTimeMillis,
  });
});

const nativeRuns = Effect.fn("test.nativeRuns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ eventId: string; agentId: string; origin: string | null }>`SELECT
      event_id AS "eventId", agent_id AS "agentId", json_extract(json, '$.origin') AS origin
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'deferral.due'
      AND json_extract(json, '$.subject.itemId') = ${scheduleId} ORDER BY received_at, event_id`;
});

const nativeCard = Effect.fn("test.nativeCard")(function* () {
  const repo = yield* Repository.KinChatRepository;
  const widget = Option.getOrThrow(
    yield* repo.getWidget({
      orgId,
      widgetId: ScheduledTasks.scheduledTaskWidgetId(orgId, scheduleId),
    }),
  );
  return { widget, state: decodeCard(widget.state) };
});

/** Run now from T3's Scheduled tasks screen, then Kin's next tick. */
const runNow = Effect.fn("test.nativeRunNow")(function* () {
  yield* TestClock.adjust("1 second");
  yield* (yield* ScheduledTaskService.ScheduledTaskService).runNow({ id: taskId });
  yield* (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
});

const bareThreads = (recorded: ReturnType<typeof harness>["recorded"]) =>
  recorded.launches.filter((launch) => launch.initialMessage !== undefined).length +
  recorded.sends.length;

it.effect(
  "a native schedule is one task and one row, wakes its lead once, and cancels cleanly",
  () => {
    const { recorded, workers, layer } = harness();
    return Effect.gen(function* () {
      yield* nativeSetup();
      const sql = yield* SqlClient.SqlClient;
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const [native] = (yield* tasks.list()).tasks;
      assert.include(native, {
        id: taskId,
        prompt,
        projectId: ProjectId.make("kin:a:lead-a"),
        threadId: null,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      assert.deepEqual(native?.schedule, {
        type: "fixed_time",
        timeOfDay: "09:00",
        weekdays: [1, 2, 3, 4, 5],
      });
      assert.lengthOf((yield* tasks.list()).tasks, 1);
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_schedules`, 1);
      yield* (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
      assert.equal((yield* nativeCard()).widget.chatId, "chat-a");

      // Its time comes on T3's clock: Kin's lead wakes, owner-only in the owner's chat, no thread.
      yield* TestClock.setTime(Date.parse(native!.nextRunAt!));
      yield* workers.get("scheduled-tasks")!;
      yield* (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
      yield* (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
      const [run] = yield* nativeRuns();
      assert.lengthOf(yield* nativeRuns(), 1);
      assert.deepInclude(run, { agentId: "lead-a", origin: null });
      assert.equal(bareThreads(recorded), 0);
      assert.equal((yield* nativeCard()).state.lastRun?.status, "running");

      // Nothing worth saying: the lead ends silently and the card says so.
      yield* leadWakeup({ orgId, eventId: run!.eventId, chatId: "chat-a" });
      yield* (yield* LeadDelivery.KinLeadDelivery).settle(orgId);
      assert.include((yield* nativeCard()).state.lastRun, { status: "skipped" });

      yield* (yield* KinSchedules.KinSchedules).cancel(orgId, scheduleId);
      assert.lengthOf((yield* tasks.list()).tasks, 0);
      yield* (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_schedules`, 0);
      assert.isNotNull((yield* nativeCard()).widget.closedAt);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a failed save leaves no task that can launch, and an orphaned task is refused", () => {
  const { recorded, layer } = harness();
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    yield* sql`UPDATE kin_leads SET models_json = ${MODELS} WHERE org_id = ${orgId}`;
    yield* sql`CREATE TRIGGER refuse_row BEFORE INSERT ON kin_schedules
      BEGIN SELECT RAISE(ABORT, 'unavailable'); END`;
    assert.equal((yield* save().pipe(Effect.flip))._tag, "KinChatError");
    assert.lengthOf((yield* tasks.list()).tasks, 0);
    yield* sql`DROP TRIGGER refuse_row`;

    // What a crash between the two writes would leave: the task with no row. It never launches.
    const { task: orphan } = yield* tasks.upsert({
      commandId: CommandId.make(`kin:schedule:${orgId}:sch-orphan`),
      title: "Orphan",
      prompt,
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
      projectId: ProjectId.make("kin:a:lead-a"),
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "invented" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdBy: "system",
      creationSource: "server",
    });
    yield* tasks.runNow({ id: orphan.id });
    assert.equal(bareThreads(recorded), 0);
    assert.equal((yield* tasks.list()).tasks[0]?.lastRunStatus, "failed");
  }).pipe(Effect.provide(layer));
});

it.effect("a native run skips while Kin is paused, as Kin's own schedules did", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* nativeSetup();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by)
      VALUES (${orgId}, 1, 0, 'owner-a')`;
    yield* runNow();
    assert.lengthOf(yield* nativeRuns(), 0);
    const notes = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${orgId} AND kind = 'system' ORDER BY seq`;
    assert.include(
      notes.map((row) => row.body),
      'Skipped "Stuck PRs": Kin is paused.',
    );
    yield* sql`DELETE FROM kin_org_state`;
    yield* runNow();
    assert.lengthOf(yield* nativeRuns(), 1);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a schedule set up privately in a group reports to the owner's chat once it is shared",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(start);
      yield* nativeSetupInGroup();
      yield* runNow();
      assert.include((yield* nativeRuns())[0]?.origin ?? "", "group-a");
      assert.equal((yield* nativeCard()).widget.chatId, "group-a");
      // Someone joined since: the private schedule speaks in the owner's chat, owner-only.
      yield* sql`UPDATE kin_chats SET shared_at = 1 WHERE chat_id = 'group-a'`;
      yield* runNow();
      assert.isNull((yield* nativeRuns())[1]?.origin ?? null);
    }).pipe(Effect.provide(layer));
  },
);

const nativeSetupInGroup = Effect.fn("test.nativeSetupInGroup")(function* () {
  yield* seed();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:30', '18:30', '03:00', 0, 1, '09:00', '{"from":"21:00","to":"08:00"}')`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
    VALUES ('group-a', ${orgId}, 'team_group', 'Plans', 0, '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('group-owner', ${orgId}, 'group-a', 'person', 'owner-a', 'owner', '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('group-lead', ${orgId}, 'group-a', 'agent', 'lead-a', 'member', '2026-11-07T00:00:00.000Z')`;
  yield* sql`UPDATE kin_leads SET models_json = ${MODELS} WHERE org_id = ${orgId}`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
      event_ids, audience) VALUES ('set-wake', ${orgId}, 'lead-a', 'test', 0, 'completed',
      '["set-event"]', 'owner_only')`;
  const asked = {
    _tag: "chat.message",
    orgId,
    agentId: "lead-a",
    eventId: "set-event",
    receivedAt: "2026-11-09T09:00:00.000Z",
    dedupeKey: null,
    provenance: { _tag: "human", personId: "owner-a", memberId: "group-owner" },
    chatId: "group-a",
    messageId: "set-message",
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES ('set-event', ${orgId}, 'lead-a', 'chat.message', 'P0', ${JSON.stringify(asked)}, 0, 0,
      'done', 'set-wake')`;
  yield* save({ chatId: "group-a" });
  yield* (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
});

it.effect("an edited prompt is put to the owner once and runs only after he confirms it", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* nativeSetup();
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const edited = "Merge every open PR on acme/app.";
    const [native] = (yield* tasks.list()).tasks;
    // Reworded in T3's Scheduled tasks screen.
    yield* tasks.upsert({ ...native!, id: taskId, prompt: edited, requireExisting: true });
    yield* runNow();
    const [ask] = yield* nativeRuns();
    // The lead is woken once, in the owner's chat, to ask; nothing else is acted on.
    assert.deepInclude(ask, { agentId: "lead-a", origin: null });
    const [row] = yield* sql<{ asked: string | null; content: string }>`SELECT
        asked_sha256 AS asked, content_sha256 AS content FROM kin_schedules`;
    assert.equal(row?.asked, yield* KinSchedules.promptSha256(edited));
    assert.notEqual(row?.content, row?.asked);
    yield* runNow();
    assert.lengthOf(yield* nativeRuns(), 1);
    assert.include((yield* nativeCard()).state.lastRun, {
      status: "skipped",
      note: "waiting for you to confirm its new wording.",
    });

    // The owner said yes: kin_schedule with replaces re-binds the hash in place.
    yield* save({ prompt: edited, existing: true });
    assert.lengthOf((yield* tasks.list()).tasks, 1);
    yield* runNow();
    assert.lengthOf(yield* nativeRuns(), 2);
  }).pipe(Effect.provide(layer));
});

it.effect("the card's Pause, Run now and Delete act on the native task", () => {
  const { recorded, layer } = harness();
  return Effect.gen(function* () {
    yield* nativeSetup();
    const chat = yield* Chat.KinChatService;
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const drain = (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
    yield* drain;
    const tap = Effect.fn("test.nativeTap")(function* (actionId: string) {
      const { widget } = yield* nativeCard();
      return yield* chat.act(owner, {
        widgetId: widget.widgetId,
        revision: widget.revision,
        actionId,
        value: scheduleId,
        clientActionId: `${actionId}-${widget.revision}`,
      });
    });
    yield* tap("pause");
    yield* drain;
    assert.isFalse((yield* tasks.list()).tasks[0]!.enabled);
    assert.include((yield* nativeCard()).state, { status: "paused" });
    // Run now still runs a paused schedule, as before.
    yield* tap("run_now");
    yield* drain;
    assert.lengthOf(yield* nativeRuns(), 1);
    yield* tap("delete");
    yield* drain;
    assert.lengthOf((yield* tasks.list()).tasks, 0);
    assert.isNotNull((yield* nativeCard()).widget.closedAt);
    assert.equal(bareThreads(recorded), 0);
  }).pipe(Effect.provide(layer));
});
