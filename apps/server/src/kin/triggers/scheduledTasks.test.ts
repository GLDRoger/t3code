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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Chat from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as CheckIns from "../pulse/checkIns.ts";
import { followOwnerZone, onHostClock, seedCheckIns } from "../pulse/checkInSeeds.ts";
import { checkInIndex } from "../pulse/prompt.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Budget from "../lead/KinBudget.ts";
import * as LeadDelivery from "../lead/LeadDelivery.ts";
import * as RoutineContent from "../lead/RoutineContent.ts";
import { leadWakeup } from "../lead/LeadDelivery.testkit.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as TriggerScheduler from "./KinTriggerScheduler.ts";
import * as TriggerService from "./KinTriggerService.ts";
import * as Retirement from "../lead/Retirement.ts";
import { dayIn } from "../work/money.ts";
import { addLead, fixture, item, orgId, seed } from "./routines.testkit.ts";
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
const identity = Layer.mock(KinIdentity)({
  owner,
  isAgentThread: () => false,
  isLeadThread: () => false,
});

/** Kin's consumer over the real native scheduler; `recorded` holds what would be bare threads. */
const harness = (
  projects?: Set<string>,
  routine: Layer.Layer<never> | Layer.Layer<RoutineContent.KinRoutineContent> = Layer.empty,
) => {
  const recorded = {
    launches: [] as ThreadLaunchService.ThreadLaunchInput[],
    sends: [] as string[],
  };
  const workers = new Map<string, Effect.Effect<void>>();
  const kinTicks = new Map<string, Effect.Effect<void>>();
  const layer = ScheduledTasks.layer.pipe(
    Layer.provideMerge(TriggerService.layer),
    Layer.provideMerge(LeadDelivery.layer),
    Layer.provideMerge(Budget.layer.pipe(Layer.provide(MemoryCache.layer))),
    Layer.provideMerge(nativeScheduler(orgId, "lead-a", recorded, workers, projects)),
    Layer.provideMerge(
      fixture([task], {
        register: Effect.fn("test.registerTick")(function* <E, R>(
          name: string,
          work: Effect.Effect<void, E, R>,
        ) {
          const context = yield* Effect.context<R>();
          kinTicks.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
        }),
      }),
    ),
    Layer.provideMerge(routine),
  );
  return { recorded, workers, kinTicks, layer };
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

/** Retiring and restoring an agent as `KinLeadProvision` commits them, after-commit work aside. */
const retirement = (agentId: string, at: number, retired: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const agent = KinAgentId.make(agentId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const retiredAt = retired ? DateTime.formatIso(DateTime.makeUnsafe(at)) : null;
        const [was] = yield* sql<{ retiredAt: string }>`SELECT retired_at AS "retiredAt"
          FROM kin_agents WHERE agent_id = ${agentId}`;
        yield* sql`UPDATE kin_agents SET retired_at = ${retiredAt} WHERE agent_id = ${agentId}`;
        if (retired)
          yield* Retirement.retire(
            { orgId, agentId: agent, retiredAt: retiredAt!, now: at },
            { closeReplaced: () => Effect.void, notice: () => Effect.die("unused") },
          );
        else
          yield* Retirement.restore({ orgId, agentId: agent, retiredAt: was!.retiredAt, now: at });
      }),
    );
  }).pipe(
    Effect.provideService(
      Retirement.KinRetiredActions,
      Retirement.KinRetiredActions.of({ close: () => Effect.void }),
    ),
  );

it.effect(
  "a fire already waiting when its chat's only agent retires waits for the restore, then runs once there",
  () =>
    Effect.gen(function* () {
      yield* setup();
      // Another live agent, in a chat of its own: it must not answer the retired one's timer.
      yield* addLead(orgId, "lead-growth", "growth", "2026-11-09T00:00:00.000Z");
      const tasks = yield* ScheduledTasks.KinScheduledTasks;
      yield* TestClock.setTime(tuesday);
      yield* (yield* TriggerScheduler.KinTriggerScheduler).runDue();
      yield* retirement("lead-a", tuesday, true);
      yield* tasks.drain(orgId);
      yield* tasks.drain(orgId);
      assert.lengthOf(yield* runs(), 0);
      assert.isNull((yield* card()).state.lastRun);

      yield* TestClock.adjust("1 minute");
      yield* retirement("lead-a", tuesday + 60_000, false);
      yield* tasks.drain(orgId);
      yield* tasks.drain(orgId);
      const delivered = yield* runs();
      assert.lengthOf(delivered, 1);
      assert.include(delivered[0], { agentId: "lead-a", itemId: "sch-prs" });
      assert.equal((yield* card()).widget.chatId, "chat-a");
      assert.equal((yield* card()).state.lastRun?.status, "running");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a fire held by retirement past the lateness limit is skipped on restore, with one notice in its chat",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const tasks = yield* ScheduledTasks.KinScheduledTasks;
      yield* TestClock.setTime(tuesday);
      yield* (yield* TriggerScheduler.KinTriggerScheduler).runDue();
      yield* retirement("lead-a", tuesday, true);
      yield* tasks.drain(orgId);
      yield* TestClock.adjust("3 hours");
      yield* retirement("lead-a", tuesday + 3 * 60 * 60_000, false);
      yield* tasks.drain(orgId);
      yield* tasks.drain(orgId);
      assert.lengthOf(yield* runs(), 0);
      const notices = yield* sql<{ chatId: string; body: string }>`SELECT chat_id AS "chatId", body
        FROM kin_messages WHERE org_id = ${orgId} AND kind = 'system' AND body LIKE 'Skipped %'
        ORDER BY seq`;
      assert.deepStrictEqual(notices, [
        {
          chatId: "chat-a",
          body: 'Skipped "Open PRs digest": it was due too long ago to run now.',
        },
      ]);
      assert.equal((yield* card()).state.lastRun?.status, "skipped");
      assert.deepStrictEqual(
        yield* sql`SELECT 1 FROM kin_trigger_inbox WHERE org_id = ${orgId} AND consumed_at IS NULL`,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

// Native schedules: the task is T3's, its kin_schedules row the authority for each run.
const scheduleId = KinMemoryItemId.make("sch-native");
const taskId = KinSchedules.scheduleTaskId(orgId, scheduleId);
const MODELS = JSON.stringify({ instanceId: "claude", model: "invented-model" });
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
  const { recorded, workers, layer } = harness();
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
    // A run already handed to Kin, then paused before Kin's tick: it doesn't run.
    const due = Effect.fn("test.nativeDue")(function* () {
      yield* TestClock.setTime(Date.parse((yield* tasks.list()).tasks[0]!.nextRunAt!));
      yield* workers.get("scheduled-tasks")!;
    });
    yield* due();
    yield* tap("pause");
    yield* drain;
    assert.isFalse((yield* tasks.list()).tasks[0]!.enabled);
    assert.include((yield* nativeCard()).state, { status: "paused" });
    assert.lengthOf(yield* nativeRuns(), 0);
    // Run now still runs a paused schedule, as before.
    yield* tap("run_now");
    yield* drain;
    assert.lengthOf(yield* nativeRuns(), 1);
    // The same when the pause comes from T3's Scheduled tasks screen.
    yield* tasks.setEnabled({ id: taskId, enabled: true });
    yield* due();
    yield* tasks.setEnabled({ id: taskId, enabled: false });
    yield* drain;
    assert.lengthOf(yield* nativeRuns(), 1);
    yield* tap("delete");
    yield* drain;
    assert.lengthOf((yield* tasks.list()).tasks, 0);
    assert.isNotNull((yield* nativeCard()).widget.closedAt);
    assert.equal(bareThreads(recorded), 0);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "Settings' check-ins show in the owner's time, and a new time, off and remove reach the task",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* nativeSetup();
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const drain = (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
      const people = [owner];
      const added = yield* CheckIns.save(people, {
        orgId,
        agentId: KinAgentId.make("lead-a"),
        title: "Morning check-in",
        what: "Look over what needs attention.",
        at: "09:30",
        days: [1, 2, 3, 4, 5],
      });
      // The chat-made schedule is not a check-in, so only the new one is listed.
      assert.lengthOf(added.checkIns, 1);
      const [made] = added.checkIns;
      // J12: it fires somewhere around 09:30, so Settings says "around", never 09:25.
      assert.include(made, {
        at: "09:30",
        around: true,
        agentName: "Lead",
        on: true,
        runNowPending: false,
      });
      assert.deepStrictEqual(made!.days, [1, 2, 3, 4, 5]);
      assert.equal(added.zone, "Asia/Kolkata");
      const moved = yield* CheckIns.save(people, {
        orgId,
        scheduleId: made!.scheduleId,
        agentId: made!.agentId,
        title: made!.title,
        what: made!.what,
        at: "11:00",
        days: [1, 3],
      });
      assert.include(moved.checkIns[0], { at: "11:00" });
      assert.lengthOf((yield* tasks.list()).tasks, 2);
      const act = (action: "run_now" | "turn_off" | "remove") =>
        CheckIns.act(people, { orgId, scheduleId: made!.scheduleId, action });
      assert.include((yield* act("turn_off")).checkIns[0], { on: false });
      assert.include((yield* act("run_now")).checkIns[0], { runNowPending: true });
      yield* drain;
      const native = (yield* tasks.list()).tasks.find((row) => row.title === "Morning check-in");
      assert.isFalse(native!.enabled);
      assert.include((yield* CheckIns.list(people, orgId)).checkIns[0], { runNowPending: false });
      assert.lengthOf((yield* act("remove")).checkIns, 0);
      yield* drain;
      assert.lengthOf((yield* tasks.list()).tasks, 1);
      // A default check-in moved here stays put when the owner's zone is followed again.
      const schedules = yield* KinSchedules.KinSchedules;
      yield* seedCheckIns(orgId, schedules);
      const morning = KinMemoryItemId.make("checkin-morning");
      const seeded = (yield* CheckIns.list(people, orgId)).checkIns.find(
        (row) => row.scheduleId === morning,
      )!;
      yield* CheckIns.save(people, { orgId, ...seeded, at: "08:15" });
      yield* followOwnerZone(orgId, schedules);
      const kept = (yield* CheckIns.list(people, orgId)).checkIns.find(
        (row) => row.scheduleId === morning,
      );
      assert.include(kept, { at: "08:15" });
      // Someone who isn't owner-level is refused.
      const teammate = { ...owner, personId: KinPersonId.make("teammate-a") };
      const refused = yield* CheckIns.list([teammate], orgId).pipe(Effect.flip);
      assert.equal(refused._tag, "KinChatError");
    }).pipe(Effect.provide(Layer.merge(layer, identity)));
  },
);

it.effect("a check-in the host slept through fires once when Kin is back that day", () => {
  const { layer, kinTicks, workers } = harness(new Set<string>());
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_leads SET models_json = ${MODELS} WHERE org_id = ${orgId}`;
    const tick = kinTicks.get("kin-scheduled-tasks")!;
    yield* tick;
    yield* CheckIns.save([owner], {
      orgId,
      agentId: KinAgentId.make("lead-a"),
      title: "Evening check-in",
      what: "Look over the day.",
      at: "18:00",
      days: [0, 1, 2, 3, 4, 5, 6],
    });
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const evening = (yield* tasks.list()).tasks.find((row) => row.title === "Evening check-in")!;
    const opens = Date.parse(evening.nextRunAt!);
    // The host sleeps through the slot and wakes twelve minutes in: T3 skips the run as missed.
    yield* TestClock.setTime(opens + 12 * 60_000);
    yield* workers.get("scheduled-tasks")!;
    const skipped = (yield* tasks.list()).tasks.find((row) => row.id === evening.id)!;
    assert.isAbove(Date.parse(skipped.nextRunAt!), opens + 12 * 60_000);
    yield* tick;
    yield* tick;
    assert.deepStrictEqual(
      yield* sql`SELECT fire_id AS "fireId", consumed_at IS NOT NULL AS done
        FROM kin_trigger_inbox WHERE fire_id LIKE ${`ns:${evening.id}:%`}`,
      [{ fireId: `ns:${evening.id}:${opens}:scheduled`, done: 1 }],
    );
  }).pipe(Effect.provide(Layer.merge(layer, identity)));
});

it.effect(
  "a lead that has never woken gets its default check-ins, and Settings can add one",
  () => {
    const projects = new Set<string>();
    const { layer, kinTicks } = harness(projects);
    return Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_leads SET models_json = ${MODELS} WHERE org_id = ${orgId}`;
      yield* kinTicks.get("kin-scheduled-tasks")!;
      assert.isTrue(projects.has(`kin:${orgId}:lead-a`));
      const people = [owner];
      const listed = yield* CheckIns.list(people, orgId);
      assert.deepStrictEqual(listed.checkIns.map((row) => row.title).toSorted(), [
        "Afternoon check-in",
        "Evening summary",
        "Morning check-in",
        "Weekly brief",
      ]);
      const added = yield* CheckIns.save(people, {
        orgId,
        agentId: KinAgentId.make("lead-a"),
        title: "Evening check-in",
        what: "Look over the day.",
        at: "18:00",
        days: [1, 2, 3, 4, 5],
      });
      assert.lengthOf(added.checkIns, 5);
    }).pipe(Effect.provide(Layer.merge(layer, identity)));
  },
);

it.effect(
  "briefs are their receiver's own: Settings and the chat move one schedule, and days and off reach it",
  () => {
    // What the evening summary would sum up today, as `KinRoutineContent` gathers it.
    const today: { evening: string | null } = { evening: null };
    const { layer, kinTicks, workers } = harness(
      undefined,
      Layer.mock(RoutineContent.KinRoutineContent)({
        eveningFacts: () => Effect.sync(() => today.evening),
      }),
    );
    return Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_leads SET models_json = ${MODELS} WHERE org_id = ${orgId}`;
      yield* kinTicks.get("kin-scheduled-tasks")!;
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const drain = (yield* ScheduledTasks.KinScheduledTasks).drain(orgId);
      const host = KinSchedules.hostTimeZone();
      const zone = "Asia/Kolkata";
      const weekdays = [1, 2, 3, 4, 5];
      const people = [owner];
      const native = (title: string) =>
        tasks.list().pipe(Effect.map(({ tasks }) => tasks.find((row) => row.title === title)!));
      // Defaults: the morning brief every day, the afternoon and evening ones on weekdays.
      assert.deepStrictEqual((yield* CheckIns.briefs(people, orgId)).briefs, [
        { kind: "morning", at: "09:30", days: [0, 1, 2, 3, 4, 5, 6], around: true, on: true },
        { kind: "afternoon", at: "15:30", days: weekdays, around: true, on: true },
        { kind: "evening", at: "18:30", days: weekdays, around: true, on: true },
      ]);

      // A day with nothing to sum up brings no evening summary; a day with something does.
      const summaries = sql<{ key: string }>`SELECT dedupe_key AS key FROM kin_events
        WHERE org_id = ${orgId} AND tag = 'pulse' AND dedupe_key LIKE 'checkin:checkin-evening:%'
        ORDER BY queued_at`;
      for (const [facts, queued] of [
        [null, 0],
        ['{"routine":"evening_summary"}', 1],
      ] as const) {
        today.evening = facts;
        yield* TestClock.setTime(Date.parse((yield* native("Evening summary")).nextRunAt!));
        yield* workers.get("scheduled-tasks")!;
        yield* drain;
        assert.lengthOf(yield* summaries, queued);
      }

      // Off: the task stops, so its next slot brings nothing; on again, it comes back.
      const save = (input: Omit<Parameters<typeof CheckIns.saveBrief>[1], "orgId">) =>
        CheckIns.saveBrief(people, { orgId, ...input });
      assert.include(
        (yield* save({ kind: "evening", at: "18:30", days: weekdays, on: false })).briefs[2],
        { on: false },
      );
      yield* drain;
      assert.isFalse((yield* native("Evening summary")).enabled);
      yield* TestClock.adjust("1 day");
      yield* workers.get("scheduled-tasks")!;
      yield* drain;
      assert.lengthOf(yield* summaries, 1);
      yield* save({ kind: "evening", at: "18:30", days: weekdays, on: true });
      yield* drain;
      assert.isTrue((yield* native("Evening summary")).enabled);

      // A day switched off is off the task; the agent's list of check-ins says the same.
      const noSaturday = [0, 1, 2, 3, 4, 5];
      yield* save({ kind: "morning", at: "08:00", days: noSaturday, on: true });
      const morning = onHostClock("08:00", noSaturday, zone, host, yield* Clock.currentTimeMillis);
      assert.deepStrictEqual(
        KinSchedules.everyOf(
          (yield* KinSchedules.readNativeTask(
            sql,
            KinSchedules.scheduleTaskId(orgId, "checkin-morning"),
          ))!,
          morning.at,
        ),
        morning,
      );
      assert.include(
        (yield* checkInIndex(orgId, KinAgentId.make("lead-a"))).join("\n"),
        `checkin-morning Morning check-in: around ${morning.at}`,
      );

      // A form opened before its days changed elsewhere saves its new time onto those days.
      const schedules = yield* KinSchedules.KinSchedules;
      const opened = (yield* CheckIns.briefs(people, orgId)).briefs[0]!;
      const chief = (yield* KinSchedules.readSchedule(sql, orgId, "checkin-morning"))!;
      yield* schedules.save({
        orgId,
        agentId: chief.agentId,
        scheduleId: chief.scheduleId,
        existing: true,
        chatId: chief.chatId,
        sourceEvent: "chat-event",
        saidBy: owner.personId,
        title: "Morning check-in",
        prompt: (yield* native("Morning check-in")).prompt,
        every: onHostClock("08:00", [1, 2, 3], zone, host, yield* Clock.currentTimeMillis),
        around: true,
        checkIn: true,
        now: yield* Clock.currentTimeMillis,
      });
      assert.include((yield* save({ ...opened, at: "08:15", changed: ["at"] })).briefs[0], {
        at: "08:15",
      });
      assert.deepStrictEqual((yield* CheckIns.briefs(people, orgId)).briefs[0]!.days, [1, 2, 3]);

      // The chat moves the same row (kin_schedule with replaces), and Settings shows it.
      const row = (yield* KinSchedules.readSchedule(sql, orgId, "checkin-afternoon"))!;
      yield* schedules.save({
        orgId,
        agentId: row.agentId,
        scheduleId: row.scheduleId,
        existing: true,
        chatId: row.chatId,
        sourceEvent: "chat-event",
        saidBy: owner.personId,
        title: "Afternoon check-in",
        prompt: "Afternoon check-in.",
        every: onHostClock("16:45", weekdays, zone, host, yield* Clock.currentTimeMillis),
        around: true,
        checkIn: true,
        now: yield* Clock.currentTimeMillis,
      });
      assert.include((yield* CheckIns.briefs(people, orgId)).briefs[1], {
        kind: "afternoon",
        at: "16:45",
      });
      assert.lengthOf(
        (yield* tasks.list()).tasks.filter((one) => one.title.startsWith("After")),
        1,
      );

      // Made exact on T3's screen, with new wording not yet confirmed: a new time keeps it
      // exact, and approves no wording.
      const afternoon = KinSchedules.scheduleTaskId(orgId, "checkin-afternoon");
      const before = (yield* CheckIns.briefs(people, orgId)).briefs[1]!;
      yield* sql`UPDATE scheduled_tasks SET prompt = 'Afternoon check-in, and chase every invoice.',
        schedule_json = json_set(schedule_json, '$.timeOfDay', '17:00') WHERE task_id = ${afternoon}`;
      yield* sql`UPDATE kin_schedules SET asked_sha256 = 'asked' WHERE task_id = ${afternoon}`;
      const approved = (yield* KinSchedules.readSchedule(sql, orgId, "checkin-afternoon"))!;
      const exact = (yield* CheckIns.briefs(people, orgId)).briefs[1]!;
      assert.include(exact, { around: false });
      // Its switch, as the list showed it before that, turns it off and puts no time back.
      assert.include((yield* save({ ...before, on: false, changed: ["on"] })).briefs[1], {
        at: exact.at,
        around: false,
        on: false,
      });
      assert.include(
        (yield* save({ kind: "afternoon", at: "18:00", days: weekdays, on: true })).briefs[1],
        { at: "18:00", around: false },
      );
      const moved = (yield* KinSchedules.readSchedule(sql, orgId, "checkin-afternoon"))!;
      assert.include(moved, {
        contentSha256: approved.contentSha256,
        askedSha256: "asked",
        looseAt: null,
      });
      assert.strictEqual(
        (yield* KinSchedules.readNativeTask(sql, afternoon))!.prompt,
        "Afternoon check-in, and chase every invoice.",
      );

      // Someone else, a co-owner included, has no briefs here and changes none of these.
      const other = { ...owner, personId: KinPersonId.make("co-owner-a") };
      assert.deepStrictEqual((yield* CheckIns.briefs([other], orgId)).briefs, []);
      const refused = yield* CheckIns.saveBrief([other], {
        orgId,
        kind: "evening",
        at: "07:00",
        days: [1],
        on: false,
      }).pipe(Effect.flip);
      assert.include(refused, { _tag: "KinChatError", reason: "not_allowed" });
      assert.include((yield* CheckIns.briefs(people, orgId)).briefs[2], { at: "18:30", on: true });

      // Made exact on T3's screen at a time before its old window, it fires at that time.
      yield* save({ kind: "morning", at: "11:00", days: weekdays, on: true });
      const nine = onHostClock("09:00", weekdays, zone, host, yield* Clock.currentTimeMillis);
      const fires = KinSchedules.timeOnDayOf(
        (yield* Clock.currentTimeMillis) + 24 * 60 * 60_000,
        host,
        nine.at,
      );
      const morningTask = KinSchedules.scheduleTaskId(orgId, "checkin-morning");
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DateTime.formatIso(DateTime.makeUnsafe(fires))},
        schedule_json = json_set(schedule_json, '$.timeOfDay', ${nine.at},
          '$.weekdays', json('[0,1,2,3,4,5,6]'))
        WHERE task_id = ${morningTask}`;
      yield* TestClock.setTime(fires);
      yield* workers.get("scheduled-tasks")!;
      yield* drain;
      assert.deepStrictEqual(
        yield* sql`SELECT not_before AS "notBefore" FROM kin_events WHERE org_id = ${orgId}
          AND dedupe_key = ${`checkin:checkin-morning:${dayIn(fires, host)}`}`,
        [{ notBefore: null }],
      );
    }).pipe(Effect.provide(Layer.merge(layer, identity)));
  },
);
