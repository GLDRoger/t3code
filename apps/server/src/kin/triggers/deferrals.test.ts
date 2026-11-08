import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinDeferralCard,
  KinEvent,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  KinWidgetId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Repository from "../chat/KinChatRepository.ts";
import * as Queue from "../lead/KinEventQueue.ts";
import { WorkerLaunchGate } from "../lead/Workers.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { fakeRepository } from "../memory/__fixtures__/repository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as MemoryWriter from "../memory/MemoryWriter.ts";
import * as DeferralFlow from "./deferralFlow.ts";
import {
  KinDeferralGithubError,
  KinDeferralGithubReader,
  type GithubLinkState,
} from "./deferralGithub.ts";
import * as Deferrals from "./deferrals.ts";
import * as TriggerScheduler from "./KinTriggerScheduler.ts";
import * as TriggerService from "./KinTriggerService.ts";
import { fixture, item, orgId, otherOrg, seed } from "./routines.testkit.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeSync(KinEvent);
const decodeCard = Schema.decodeSync(Schema.fromJsonString(KinDeferralCard));
const issue = "https://github.com/acme/api/issues/12";
const makeDeferral = (id: string, overrides: Partial<MemoryItemHead> = {}) =>
  item(id, {
    kind: "deferral",
    path: `deferrals/${id}.md`,
    due: "2026-11-13T09:00+05:30",
    on_due: "start",
    chat: KinChatId.make("chat-a"),
    links: [],
    ...overrides,
  });
const deferral = makeDeferral("def-1");
const widgetFor = (itemId: string) => KinWidgetId.make(`deferral:${orgId}:${itemId}`);
const widgetId = widgetFor("def-1");
const dueAt = Date.parse("2026-11-13T03:30:00.000Z");
const headsUpAt = dueAt - 30 * 60_000;

const layerFor = <E = never>(
  items: ReadonlyArray<MemoryItemHead>,
  options: Parameters<typeof fixture<E>>[1] = {},
) =>
  DeferralFlow.layer.pipe(
    Layer.provideMerge(Deferrals.layer),
    Layer.provideMerge(TriggerService.layer),
    Layer.provideMerge(fixture(items, options)),
  );

const fakeGithub = (states: Map<string, Omit<GithubLinkState, "link">>) => ({
  read: (org: typeof orgId, ref: { readonly repo: string; readonly number: number }) => {
    const state = states.get(`${ref.repo}#${ref.number}`);
    return state === undefined
      ? Effect.fail(new KinDeferralGithubError({ orgId: org, reason: "not_found" }))
      : Effect.succeed(state);
  },
});
// Stands in for LEAD-11, the worker release gate and #44's GitHub client.
const openGates =
  (states: Map<string, Omit<GithubLinkState, "link">>, stopped = false) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(WorkerLaunchGate, true),
      Effect.provideService(Deferrals.KinDeferralStopSwitch, {
        isStopped: () => Effect.succeed(stopped),
      }),
      Effect.provideService(KinDeferralGithubReader, fakeGithub(states)),
    );

const setup = Effect.fn("test.deferralFlowSetup")(function* (level = "L2") {
  yield* seed();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:30', '18:30', '03:00', 0, 1, '09:00', '{"from":"21:00","to":"08:00"}')`;
  yield* sql`UPDATE kin_leads SET level = ${level} WHERE org_id = ${orgId}`;
  yield* TestClock.setTime(Date.parse("2026-11-09T09:00:00.000Z"));
});

const tick = Effect.fn("test.deferralTick")(function* (at: number) {
  yield* TestClock.setTime(at);
  yield* (yield* TriggerScheduler.KinTriggerScheduler).runDue();
  yield* (yield* DeferralFlow.KinDeferralFlow).drain(orgId);
});

const runOf = Effect.fn("test.deferralRun")(function* (itemId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ state: string; dueAt: number }>`SELECT state, due_at AS "dueAt"
    FROM kin_deferral_runs WHERE org_id = ${orgId} AND item_id = ${itemId} ORDER BY item_id`;
  return row;
});

const cardOf = Effect.fn("test.deferralCard")(function* (itemId: string) {
  const repo = yield* Repository.KinChatRepository;
  const widget = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId: widgetFor(itemId) }));
  return { ...decodeCard(encodeJson(widget.state)), revision: widget.revision };
});

const starts = Effect.fn("test.deferralStarts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ dedupeKey: string; json: string }>`SELECT dedupe_key AS "dedupeKey", json
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'deferral.due' ORDER BY event_id`;
});

const pendingFires = Effect.fn("test.deferralPending")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ fireId: string }>`SELECT fire_id AS "fireId" FROM kin_trigger_inbox
    WHERE org_id = ${orgId} AND consumed_at IS NULL ORDER BY fire_id`;
});

const tapOnce = Effect.fn("test.deferralTap")(function* (
  actionId: string,
  label: string,
  staged: Array<MemoryWriter.MemoryChange>,
  target: KinWidgetId = widgetId,
  value = "def-1",
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const queue = yield* Queue.KinEventQueue;
  const deferrals = yield* Deferrals.Deferrals;
  const writer = Layer.mock(MemoryWriter.MemoryWriter)({
    stage: (_org, _wakeup, change) => Effect.sync(() => void staged.push(change)),
  });
  const memberId = "owner-member-a";
  const revision = Option.match(yield* repo.getWidget({ orgId, widgetId: target }), {
    onNone: () => 1,
    onSome: (widget) => widget.revision,
  });
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
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
    body: encodeJson({ widgetId: target, revision, actionId, value }),
    intent: null,
    mentions: [],
    replyTo: KinMessageId.make(target),
    widgetId: target,
    floorRunId: null,
    status: "posted",
    sentBy: KinPersonId.make("owner-a"),
    clientMessageId: { kind: "act", id: `${actionId}-${label}` },
    createdAt: at,
    editedAt: null,
  });
  const eventId = `${actionId}-${label}`;
  yield* queue.enqueue(
    decodeEvent({
      _tag: "widget.action",
      orgId,
      eventId,
      agentId: "lead-a",
      receivedAt: at,
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
const tap = (...args: Parameters<typeof tapOnce>) => Effect.scoped(tapOnce(...args));

it.effect("applies verified owner taps on the confirm card and ignores forged ones", () =>
  Effect.gen(function* () {
    yield* setup();
    const repo = yield* Repository.KinChatRepository;
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    const staged: Array<MemoryWriter.MemoryChange> = [];

    const remind = yield* tap("remind", "owner", staged);
    assert.equal(remind._tag === "Success" && remind.success.action, "remind");
    assert.lengthOf(staged, 1);
    assert.equal(staged[0]?.sourceEventId, "remind-owner");
    assert.include(staged[0]!.content, "on_due: remind");

    const change = yield* tap("change", "owner", staged);
    assert.equal(change._tag === "Success" && change.success.action, "change");
    assert.lengthOf(staged, 1);
    // Heads-up actions don't apply to the confirm card.
    assert.equal((yield* tap("start_now", "confirm", staged))._tag, "Failure");

    const real = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId }));
    const forgedId = KinWidgetId.make("model-card");
    const anchor = yield* repo.insertMessage({
      orgId,
      chatId: real.chatId,
      messageId: KinMessageId.make(forgedId),
      author: { _tag: "system" },
      kind: "system",
      body: "",
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: "2026-11-09T09:00:00.000Z",
      editedAt: null,
    });
    yield* repo.insertWidget({
      orgId,
      chatId: real.chatId,
      messageId: anchor.messageId,
      widgetId: forgedId,
      widgetClass: "native",
      type: "deferral",
      state: real.state,
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: "2026-11-09T09:00:00.000Z",
    });
    assert.equal((yield* tap("remind", "forged", staged, forgedId))._tag, "Failure");
    assert.lengthOf(staged, 1);

    const member = yield* tap("remind", "demoted", staged);
    assert.equal(member._tag, "Failure");
    assert.lengthOf(staged, 1);
  }).pipe(Effect.provide(layerFor([deferral]))),
);

it.effect("unchanged recheck, heads-up, silence, then starts once at due", () => {
  const github = new Map([
    ["acme/api#12", { state: "open" as const, assignees: ["bob"], linkedPrs: [] }],
  ]);
  const linked = makeDeferral("def-1", { links: [issue] });
  const foreign = makeDeferral("def-b", { orgId: otherOrg, chat: KinChatId.make("chat-b") });
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const service = yield* TriggerService.KinTriggerService;
    yield* service.syncItem(linked);
    yield* service.syncItem(foreign);
    const foreignState = () =>
      Effect.all({
        runs: sql`SELECT state, due_at FROM kin_deferral_runs WHERE org_id = ${otherOrg}
          ORDER BY item_id`,
        cards: sql`SELECT revision, state_json FROM kin_widgets WHERE org_id = ${otherOrg}
          ORDER BY widget_id`,
      });
    const foreignBefore = yield* foreignState();

    yield* tick(headsUpAt);
    assert.equal((yield* runOf("def-1"))?.state, "heads_up");
    const headsUp = yield* cardOf("def-1");
    assert.equal(headsUp.phase, "heads_up");
    assert.equal(headsUp.text, "Starting def-1 at 9:00.");

    yield* tick(headsUpAt + 15 * 60_000);
    assert.equal((yield* runOf("def-1"))?.state, "heads_up");
    assert.lengthOf(yield* starts(), 0);

    yield* tick(dueAt);
    assert.equal((yield* runOf("def-1"))?.state, "started");
    assert.equal((yield* cardOf("def-1")).phase, "started");
    const [started] = yield* starts();
    assert.equal(started?.dedupeKey, `deferral:def-1:due:${dueAt}`);
    assert.lengthOf(yield* pendingFires(), 0);

    // A later replay of the due fire after a crash enqueues the same event, not a second worker.
    yield* sql`UPDATE kin_trigger_inbox SET consumed_at = NULL WHERE org_id = ${orgId}`;
    yield* sql`UPDATE kin_deferral_runs SET state = 'heads_up' WHERE org_id = ${orgId}`;
    yield* tick(dueAt + 5 * 60_000);
    assert.lengthOf(yield* starts(), 1);
    assert.equal((yield* runOf("def-1"))?.state, "started");
    assert.lengthOf(yield* pendingFires(), 0);

    // Org a's ticks never touch org b's run, card or fires.
    assert.deepStrictEqual(yield* foreignState(), foreignBefore);
    const foreignFires = yield* sql`SELECT fire_id FROM kin_trigger_inbox
      WHERE org_id = ${otherOrg} AND consumed_at IS NULL ORDER BY fire_id`;
    assert.lengthOf(foreignFires, 2);
  }).pipe(openGates(github), Effect.provide(layerFor([linked, foreign])));
});

it.effect("asks instead of starting when a linked issue closes before due", () => {
  const github = new Map<string, Omit<GithubLinkState, "link">>([
    ["acme/api#12", { state: "open", assignees: [], linkedPrs: [] }],
  ]);
  const linked = makeDeferral("def-1", { links: [issue] });
  return Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(linked);
    yield* tick(headsUpAt);
    assert.equal((yield* runOf("def-1"))?.state, "heads_up");

    github.set("acme/api#12", { state: "closed", assignees: [], linkedPrs: [41] });
    yield* tick(dueAt);
    assert.equal((yield* runOf("def-1"))?.state, "asked");
    const asked = yield* cardOf("def-1");
    assert.equal(asked.phase, "asked");
    assert.include(asked.text, "acme/api#12 is closed");
    assert.include(asked.text, "PR #41 was linked to acme/api#12");
    assert.lengthOf(yield* starts(), 0);
  }).pipe(openGates(github), Effect.provide(layerFor([linked])));
});

it.effect("asks when the stop switch is on, and production defaults never start", () => {
  const stopped = makeDeferral("def-1");
  const linked = makeDeferral("def-2", {
    links: [issue],
    due: "2026-11-13T10:00+05:30",
  });
  return Effect.gen(function* () {
    yield* setup("L0");
    const service = yield* TriggerService.KinTriggerService;
    yield* service.syncItem(stopped);
    yield* tick(headsUpAt);
    yield* tick(dueAt);
    assert.equal((yield* runOf("def-1"))?.state, "asked");
    assert.include((yield* cardOf("def-1")).text, "the stop switch is on");

    // No stop switch, GitHub reader, worker release or L2 yet: every gate asks.
    yield* service
      .syncItem(linked)
      .pipe(Effect.provideService(KinDeferralGithubReader, KinDeferralGithubReader.defaultValue()));
    yield* tick(dueAt + 30 * 60_000);
    yield* tick(dueAt + 60 * 60_000);
    assert.equal((yield* runOf("def-2"))?.state, "asked");
    const text = (yield* cardOf("def-2")).text;
    for (const reason of [
      "couldn't verify GitHub",
      "the stop switch is on",
      "workers can't launch yet",
      "Kin is at L0, below L2",
    ])
      assert.include(text, reason);
    assert.lengthOf(yield* starts(), 0);
  }).pipe(
    Effect.provideService(Deferrals.KinDeferralStopSwitch, {
      isStopped: () => Effect.succeed(true),
    }),
    Effect.provide(layerFor([stopped, linked])),
  );
});

it.effect(
  "heads-up taps: [Monday] re-arms next Monday 09:00, [Cancel] cancels, [Start now] starts",
  () => {
    const items = [deferral];
    return Effect.gen(function* () {
      yield* setup();
      const service = yield* TriggerService.KinTriggerService;
      yield* service.syncItem(deferral);
      yield* tick(headsUpAt);
      assert.equal((yield* cardOf("def-1")).phase, "heads_up");
      const staged: Array<MemoryWriter.MemoryChange> = [];

      const monday = yield* tap("monday", "owner", staged);
      assert.equal(
        monday._tag === "Success" && monday.success.due,
        "2026-11-16T09:00:00.000+05:30",
      );
      assert.include(staged[0]!.content, "due: 2026-11-16T09:00:00.000+05:30");
      const cancel = yield* tap("cancel", "owner", staged);
      assert.equal(cancel._tag, "Success");
      assert.include(staged[1]!.content, "status: cancelled");

      // An owner tap isn't a level grant: [Start now] passes the same gates as silence.
      const sql = yield* SqlClient.SqlClient;
      const before = { run: yield* runOf("def-1"), card: yield* cardOf("def-1") };
      const refusals = [
        yield* tap("start_now", "stopped", staged).pipe(
          Effect.provideService(Deferrals.KinDeferralStopSwitch, {
            isStopped: () => Effect.succeed(true),
          }),
        ),
        yield* tap("start_now", "gated", staged).pipe(
          Effect.provideService(WorkerLaunchGate, false),
        ),
      ];
      yield* sql`UPDATE kin_leads SET level = 'L1' WHERE org_id = ${orgId}`;
      refusals.push(yield* tap("start_now", "level", staged));
      yield* sql`UPDATE kin_leads SET level = 'L2' WHERE org_id = ${orgId}`;
      assert.deepStrictEqual(
        refusals.map((result) => result._tag === "Failure" && result.failure.cause),
        ["stopped", "workers_blocked", "below_l2"],
      );
      assert.deepStrictEqual({ run: yield* runOf("def-1"), card: yield* cardOf("def-1") }, before);
      assert.lengthOf(yield* starts(), 0);

      const start = yield* tap("start_now", "owner", staged);
      assert.equal(start._tag === "Success" && start.success.action, "start_now");
      assert.equal((yield* runOf("def-1"))?.state, "started");
      const [started] = yield* starts();
      assert.equal(started?.dedupeKey, `deferral:def-1:due:${dueAt}`);
      assert.include(started!.json, '"_tag":"human"');
      assert.equal((yield* tap("start_now", "again", staged))._tag, "Failure");
      // The due fire finds the run started and starts nothing more.
      yield* tick(dueAt);
      assert.lengthOf(yield* starts(), 1);

      // The [Monday] commit reaches the cache hook and re-arms the triggers.
      items[0] = makeDeferral("def-1", { due: "2026-11-16T09:00:00.000+05:30" });
      assert.equal(yield* service.syncItem(items[0]), "armed");
      const nextDue = Date.parse("2026-11-16T03:30:00.000Z");
      const triggers = yield* sql<{ id: string; nextRunAt: number | null }>`SELECT trigger_id AS id,
      next_run_at AS "nextRunAt" FROM kin_triggers WHERE org_id = ${orgId} ORDER BY trigger_id`;
      assert.deepStrictEqual(triggers, [
        { id: "deferral:def-1:due", nextRunAt: nextDue },
        { id: "deferral:def-1:heads_up", nextRunAt: nextDue - 30 * 60_000 },
      ]);
      assert.deepStrictEqual(yield* runOf("def-1"), { state: "armed", dueAt: nextDue });
      const card = yield* cardOf("def-1");
      assert.equal(card.phase, undefined);
      assert.equal(card.text, "Deferred to Mon 16 Nov, 9:00. I'll start then.");
    }).pipe(openGates(new Map()), Effect.provide(layerFor(items)));
  },
);

it.effect(
  "late due fires: two hours late asks; within the grace, starts after a grace from now",
  () => {
    const late = makeDeferral("def-1");
    const graced = makeDeferral("def-2", { due: "2026-11-13T10:00+05:30" });
    const gracedDue = Date.parse("2026-11-13T04:30:00.000Z");
    return Effect.gen(function* () {
      yield* setup();
      const service = yield* TriggerService.KinTriggerService;
      yield* service.syncItem(late);
      yield* service.syncItem(graced);

      const wake = gracedDue + 15 * 60_000;
      yield* tick(wake);
      assert.equal((yield* runOf("def-1"))?.state, "asked");
      const asked = (yield* cardOf("def-1")).text;
      assert.include(asked, "it's more than 30 minutes late");
      assert.include(asked, "This was due at 9:00.");

      assert.equal((yield* runOf("def-2"))?.state, "grace");
      const grace = yield* cardOf("def-2");
      assert.equal(grace.phase, "heads_up");
      assert.equal(grace.text, "Starting def-2 at 10:45. This was due at 10:00.");
      assert.equal(grace.graceEndsAt, DateTime.formatIso(DateTime.makeUnsafe(wake + 30 * 60_000)));
      assert.lengthOf(yield* starts(), 0);
      assert.lengthOf(yield* pendingFires(), 0);

      yield* tick(wake + 30 * 60_000);
      assert.equal((yield* runOf("def-2"))?.state, "started");
      const [started] = yield* starts();
      assert.equal(started?.dedupeKey, `deferral:def-2:due:${gracedDue}`);
      assert.equal((yield* runOf("def-1"))?.state, "asked");
    }).pipe(openGates(new Map()), Effect.provide(layerFor([late, graced])));
  },
);

it.effect("drops queued fires for disarmed or moved deferrals", () => {
  const items = [
    makeDeferral("def-1", { on_due: "remind" }),
    makeDeferral("def-2", { on_due: "remind" }),
    makeDeferral("def-3"),
  ];
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const service = yield* TriggerService.KinTriggerService;
    const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
    for (const entry of items) yield* service.syncItem(entry);
    yield* TestClock.setTime(dueAt);
    yield* scheduler.runDue();
    assert.lengthOf(yield* pendingFires(), 4);

    // def-3's 9:00 due fire is still queued when due moves to 8:50, already past.
    items[2] = makeDeferral("def-3", { due: "2026-11-13T08:50+05:30" });
    assert.equal(yield* service.syncItem(items[2]), "armed");
    yield* scheduler.runDue();

    assert.equal(
      yield* service.syncItem(makeDeferral("def-1", { on_due: "remind", status: "done" })),
      "disarmed",
    );
    const moved = makeDeferral("def-2", { on_due: "remind", due: "2026-11-14T09:00+05:30" });
    items[1] = moved;
    assert.equal(yield* service.syncItem(moved), "armed");
    yield* (yield* DeferralFlow.KinDeferralFlow).drain(orgId);
    assert.lengthOf(yield* pendingFires(), 0);
    assert.equal((yield* runOf("def-1"))?.state, "disarmed");
    assert.equal((yield* runOf("def-2"))?.state, "armed");
    // 8:50 is handled and goes to grace; the old 9:00 fire isn't taken for the grace fire.
    assert.equal((yield* runOf("def-3"))?.state, "grace");
    assert.lengthOf(yield* starts(), 0);
    yield* tick(dueAt + 30 * 60_000);
    assert.equal((yield* runOf("def-3"))?.state, "started");
    assert.lengthOf(yield* starts(), 1);
    const reminders = () =>
      sql<{ body: string }>`SELECT body FROM kin_messages WHERE org_id = ${orgId}
        AND body LIKE 'Reminder:%' ORDER BY seq`;
    assert.lengthOf(yield* reminders(), 0);

    yield* tick(Date.parse("2026-11-14T03:30:00.000Z"));
    assert.deepStrictEqual(yield* reminders(), [{ body: "Reminder: def-2." }]);
  }).pipe(openGates(new Map()), Effect.provide(layerFor(items)));
});

it.effect("remind, ask and chase act at due, noting lateness", () => {
  const remind = makeDeferral("def-r", { on_due: "remind" });
  const ask = makeDeferral("def-a", { on_due: "ask" });
  const chase = makeDeferral("def-c", { on_due: "chase", owner: "owner" });
  const quiet = makeDeferral("def-q", {
    on_due: "chase",
    owner: "owner",
    due: "2026-11-13T07:00+05:30",
  });
  const broken = makeDeferral("def-x", { on_due: "ask" });
  const items = [remind, ask, chase, quiet, broken];
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const service = yield* TriggerService.KinTriggerService;
    for (const entry of items) yield* service.syncItem(entry);
    const quietPings = () =>
      sql`SELECT body FROM kin_messages WHERE org_id = ${orgId}
        AND body LIKE '%def-q was due%' ORDER BY seq`;

    // A chase due in quiet hours waits for a later tick, then pings once.
    yield* tick(Date.parse("2026-11-13T01:30:00.000Z"));
    assert.equal((yield* runOf("def-q"))?.state, "chased");
    assert.lengthOf(yield* quietPings(), 0);
    yield* tick(Date.parse("2026-11-13T02:35:00.000Z"));
    assert.lengthOf(yield* quietPings(), 1);

    yield* sql`UPDATE kin_deferral_runs SET snapshot_json = 'not json'
      WHERE org_id = ${orgId} AND item_id = 'def-x'`;
    yield* tick(dueAt + 20 * 60_000);
    yield* tick(dueAt + 25 * 60_000);
    assert.lengthOf(yield* quietPings(), 1);

    const messages = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${orgId} AND kind = 'system' ORDER BY seq`;
    assert.isTrue(messages.some(({ body }) => body === "Reminder: def-r. This was due at 9:00."));
    assert.isTrue(
      messages.some(({ body }) =>
        body.includes("def-c was due Fri 13 Nov, 9:00. What's the status?"),
      ),
    );
    assert.equal((yield* runOf("def-r"))?.state, "reminded");
    assert.equal((yield* runOf("def-a"))?.state, "asked");
    const asked = yield* cardOf("def-a");
    assert.equal(asked.phase, "asked");
    assert.include(asked.text, "This was due at 9:00.");
    assert.equal((yield* runOf("def-c"))?.state, "chased");
    const ledger =
      yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY item_id`;
    assert.lengthOf(ledger, 2);
    assert.lengthOf(yield* starts(), 0);

    // A fire that can't be handled is consumed after telling the owner.
    assert.isTrue(
      messages.some(
        ({ body }) => body === "I couldn't handle the deferral def-x due Fri 13 Nov, 9:00.",
      ),
    );
    assert.equal((yield* runOf("def-x"))?.state, "armed");
    assert.lengthOf(yield* pendingFires(), 0);
  }).pipe(Effect.provide(layerFor(items)));
});

it.effect("chases through the real memory lock without reading memory inside the write", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const repository = fakeRepository(fs);
    for (const dir of ["memory/.git/objects", "memory/.git/refs", "memory-read"])
      yield* fs.makeDirectory(`${root}/a/${dir}`, { recursive: true });
    const memoryItem = (id: string, due: string, onDue: string) =>
      fixtureItem({
        id,
        due,
        on_due: onDue,
        owner: "owner",
        said_by: "owner",
        chat: "chat-a",
        links: [],
      });
    repository.files.set(
      "deferrals/def-c.md",
      memoryItem("def-c", "2026-11-13T09:00+05:30", "chase"),
    );
    const writing: Array<string> = [];
    const spied = Layer.effect(
      Memory.Memory,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* Memory.Memory;
        // Any memory call while this fiber holds the SQLite writer can deadlock against load.
        const spy = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
          Effect.serviceOption(sql.transactionService).pipe(
            Effect.tap((open) => Effect.sync(() => Option.isSome(open) && writing.push(name))),
            Effect.andThen(effect),
          );
        return Memory.Memory.of({
          ...memory,
          query: (org, q) => spy("query", memory.query(org, q)),
          readItem: (org, id) => spy("readItem", memory.readItem(org, id)),
          readItemQuietly: (org, id) => spy("readItemQuietly", memory.readItemQuietly(org, id)),
        });
      }),
    ).pipe(
      Layer.provide(Memory.layer),
      Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
      Layer.provide(TriggerService.syncHooksLayer.pipe(Layer.provide(TriggerService.layer))),
      Layer.provide(
        Layer.succeed(MemoryConfig.MemoryConfig, {
          baseDirectory: root,
          repositories: [{ orgId, repoUrl: "unused", path: "a" }],
        }),
      ),
      Layer.provide(repository.layer),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const memory = yield* Memory.Memory;
      yield* memory.anchor(orgId, "main", repository.head());
      yield* memory.query(orgId, {});
      assert.equal((yield* runOf("def-c"))?.state, "armed");

      // A new head lands before the chase, so its load re-syncs triggers under the memory lock.
      repository.files.set(
        "deferrals/def-n.md",
        memoryItem("def-n", "2026-11-20T09:00+05:30", "remind"),
      );
      yield* memory.record(orgId, "main", yield* memory.anchor(orgId, "main"), repository.commit());
      yield* tick(dueAt);

      assert.equal((yield* runOf("def-c"))?.state, "chased");
      assert.equal((yield* runOf("def-n"))?.state, "armed");
      const pings = yield* sql`SELECT person FROM kin_ping_items
        WHERE org_id = ${orgId} AND item_id = 'def-c' ORDER BY person`;
      assert.deepStrictEqual(pings, [{ person: "owner-a" }]);
      assert.deepStrictEqual(writing, []);
    }).pipe(Effect.provide(layerFor([], { memory: spied })));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("backs off a failing fire and warns once", () => {
  const remind = makeDeferral("def-r", { on_due: "remind" });
  const failures: Array<string> = [];
  const logger = Logger.layer(
    [
      Logger.make(({ message, logLevel }) => {
        if (String(message).includes("Kin deferral fire processing failed"))
          failures.push(logLevel);
      }),
    ],
    { mergeWithExisting: false },
  );
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* TriggerService.KinTriggerService).syncItem(remind);
    yield* sql`CREATE TEMP TRIGGER fail_remind BEFORE INSERT ON kin_messages
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
    for (const seconds of [0, 5, 60, 90, 180]) yield* tick(dueAt + seconds * 1000);
    // Retries at +1 and +3 minutes, each after a longer wait.
    assert.deepStrictEqual(failures, ["Warn", "Debug", "Debug"]);
    yield* sql`DROP TRIGGER fail_remind`;
    yield* tick(dueAt + 400_000);
    assert.lengthOf(failures, 3);
    yield* tick(dueAt + 420_000);
    assert.equal((yield* runOf("def-r"))?.state, "reminded");
    assert.lengthOf(yield* pendingFires(), 0);
  }).pipe(
    Effect.provide(layerFor([remind])),
    Effect.provide(logger),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  );
});

it.effect("sweeps pings once a minute unless a chase just put one", () => {
  const chase = makeDeferral("def-c", { on_due: "chase", owner: "owner" });
  const items = [chase];
  let sweeps = 0;
  const query = () => (org: typeof orgId) =>
    Effect.sync(() => {
      sweeps++;
      return items
        .filter((entry) => entry.orgId === org)
        .map((entry) => ({ ...entry, duplicate: false }));
    });
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const service = yield* TriggerService.KinTriggerService;
    yield* service.syncItem(chase);
    yield* tick(dueAt);
    assert.equal((yield* runOf("def-c"))?.state, "chased");
    assert.equal(sweeps, 1);
    yield* tick(dueAt + 5_000);
    assert.equal(sweeps, 1);
    yield* tick(dueAt + 65_000);
    assert.equal(sweeps, 2);

    // Re-chasing with a new due while the first ping is pending asks instead.
    items[0] = makeDeferral("def-c", {
      on_due: "chase",
      owner: "owner",
      due: "2026-11-14T09:00+05:30",
    });
    assert.equal(yield* service.syncItem(items[0]), "armed");
    yield* tick(dueAt + 24 * 60 * 60_000);
    assert.equal((yield* runOf("def-c"))?.state, "asked");
    assert.include((yield* cardOf("def-c")).text, "I couldn't chase owner");
    assert.equal(sweeps, 3);

    // An undecodable inbox row fails the drain, but the sweep still runs.
    yield* sql`INSERT INTO kin_trigger_inbox (fire_id, org_id, payload_json, received_at)
      VALUES ('bad', ${orgId}, '{"payload":{"subject":{"type":"deferral"}}}', 0)`;
    const failed = yield* tick(dueAt + 24 * 60 * 60_000 + 65_000).pipe(Effect.flip);
    assert.equal(failed._tag, "KinDeferralFlowError");
    assert.equal(sweeps, 4);
  }).pipe(Effect.provide(layerFor(items, { query })));
});
