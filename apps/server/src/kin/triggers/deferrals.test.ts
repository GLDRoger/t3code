import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinDeferralCard,
  KinEvent,
  KinEventId,
  KinMemberId,
  KinMemoryItemId,
  KinPersonId,
  KinWakeupId,
  KinWidgetId,
  kinReminderWidgetId,
  KIN_ASKER_ONLY_REFUSAL,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Chat from "../chat/KinChatService.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { turnAudience } from "../lead/Audience.ts";
import * as Budget from "../lead/KinBudget.ts";
import * as Queue from "../lead/KinEventQueue.ts";
import * as LeadDelivery from "../lead/LeadDelivery.ts";
import { leadWakeup } from "../lead/LeadDelivery.testkit.ts";
import { laneFor } from "../reply/replyLane.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { fakeRepository } from "../memory/__fixtures__/repository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as DeferralFlow from "./deferralFlow.ts";
import { KinDeferralGithubReader, type GithubLinkState } from "./deferralGithub.ts";
import * as Deferrals from "./deferrals.ts";
import * as TriggerScheduler from "./KinTriggerScheduler.ts";
import * as TriggerService from "./KinTriggerService.ts";
import { addLead, fixture, item, orgId, otherOrg, seed } from "./routines.testkit.ts";

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

// As the lead runtime does: a card's decision tap reads its committed item through memory.
const attachItems = Layer.effectDiscard(
  Effect.gen(function* () {
    const memory = yield* Memory.Memory;
    yield* (yield* Chat.KinChatService).attachDeferralItems((orgId, itemId) =>
      memory
        .readItemQuietly(orgId, itemId, "triggers")
        .pipe(Effect.asSome, Effect.catchTags({ MemoryNotFound: () => Effect.succeedNone })),
    );
  }),
);

const layerFor = <E = never>(
  items: ReadonlyArray<MemoryItemHead>,
  options: Parameters<typeof fixture<E>>[1] = {},
) =>
  Layer.merge(DeferralFlow.layer, attachItems).pipe(
    Layer.provideMerge(TriggerService.layer),
    Layer.provideMerge(LeadDelivery.layer),
    Layer.provideMerge(Budget.layer.pipe(Layer.provide(MemoryCache.layer))),
    Layer.provideMerge(fixture(items, options)),
  );

const fakeGithub = (states: Map<string, Omit<GithubLinkState, "link">>) => ({
  readRepo: (_org: typeof orgId, repo: string, numbers: ReadonlyArray<number>) =>
    Effect.succeed(
      new Map(
        numbers.flatMap((number) => {
          const state = states.get(`${repo}#${number}`);
          return state === undefined ? [] : [[number, state] as const];
        }),
      ),
    ),
});
// Stands in for LEAD-11 and #44's GitHub client.
const openGates =
  (states: Map<string, Omit<GithubLinkState, "link">>, stopped = false) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
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
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'deferral.due'
      AND json_extract(json, '$.subject.type') = 'deferral' ORDER BY event_id`;
});

/** Reminders handed to the lead to write, by item. */
const handedReminders = Effect.fn("test.deferralReminders")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ itemId: string; lateByMs: number }>`SELECT
      json_extract(json, '$.subject.itemId') AS "itemId", json_extract(json, '$.lateByMs') AS "lateByMs"
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'deferral.due'
      AND json_extract(json, '$.subject.type') = 'reminder' ORDER BY received_at, event_id`;
});

const pendingFires = Effect.fn("test.deferralPending")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ fireId: string }>`SELECT fire_id AS "fireId" FROM kin_trigger_inbox
    WHERE org_id = ${orgId} AND consumed_at IS NULL ORDER BY fire_id`;
});

/** A person's tap on the item's card, through the chat's own act. */
const tap = Effect.fn("test.deferralTap")(function* (
  actionId: string,
  personId = `owner-${orgId}`,
  itemId = "def-1",
  target: KinWidgetId = widgetFor(itemId),
) {
  const repo = yield* Repository.KinChatRepository;
  const chat = yield* Chat.KinChatService;
  const revision = Option.match(yield* repo.getWidget({ orgId, widgetId: target }), {
    onNone: () => 1,
    onSome: (widget) => widget.revision,
  });
  return yield* chat
    .act(
      { _tag: "person", orgId, personId: KinPersonId.make(personId) },
      {
        widgetId: target,
        revision,
        actionId,
        value: itemId,
        clientActionId: `${actionId}-${personId}-${target}-${revision}`,
      },
    )
    .pipe(Effect.result);
});
const outcome = (result: Effect.Success<ReturnType<typeof tap>>) =>
  result._tag === "Success"
    ? "ok"
    : result.failure._tag === "KinChatError"
      ? result.failure.reason
      : result.failure._tag;

/** Another person in the company, in the owner's chat with the lead. */
const joinChat = Effect.fn("test.deferralJoin")(function* (
  personId: string,
  access: "co_owner" | "member",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
    VALUES (${personId}, ${orgId}, ${personId}, ${personId}, ${access}, 0)`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      role, joined_at)
    VALUES (${`member-${personId}`}, ${orgId}, 'chat-a', 'person', ${personId}, 'member',
      '2026-11-07T00:00:00.000Z')`;
});

const nextMonday = Date.parse("2026-11-16T03:30:00.000Z");
const triggersOf = Effect.fn("test.deferralTriggers")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ id: string; enabled: number; nextRunAt: number | null }>`SELECT
      trigger_id AS id, enabled, next_run_at AS "nextRunAt" FROM kin_triggers
    WHERE org_id = ${orgId} ORDER BY trigger_id`;
});

it.effect("the confirm card offers Undo alone, and says Kin will ask before it starts", () =>
  Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    const card = yield* cardOf("def-1");
    assert.deepStrictEqual(card.actions, ["undo"]);
    assert.equal(card.text, "Deferred to Fri, 13 Nov, 9:00 am. I'll ask you to start it then.");
    // What the card no longer offers reads as a card that changed, and changes nothing.
    for (const action of ["change", "remind", "start_now", "monday", "cancel"])
      assert.equal(outcome(yield* tap(action)), "widget_changed");
    assert.deepStrictEqual(yield* runOf("def-1"), { state: "armed", dueAt });
    assert.equal((yield* cardOf("def-1")).revision, card.revision);
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
    assert.equal(headsUp.text, "Starting def-1 at 9:00 am.");

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
    assert.include((yield* cardOf("def-1")).text, "Kin asks before every start for now");

    // No stop switch, GitHub reader or L2 yet: every gate asks.
    yield* service
      .syncItem(linked)
      .pipe(Effect.provideService(KinDeferralGithubReader, KinDeferralGithubReader.defaultValue()));
    yield* tick(dueAt + 30 * 60_000);
    yield* tick(dueAt + 60 * 60_000);
    assert.equal((yield* runOf("def-2"))?.state, "asked");
    const text = (yield* cardOf("def-2")).text;
    for (const reason of [
      "couldn't verify GitHub",
      "Kin asks before every start for now",
      "starting work isn't open to me here",
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
  "a deferral asked for in a chat that can't start work asks, and the owner's [Start now] starts it",
  () => {
    const asked = makeDeferral("def-1", { source_event: KinEventId.make("asked") });
    return Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const lead = `lead-${orgId}`;
      // kin_defer's source event came from a group whose cap is below L2.
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES ('team', ${orgId}, 'team_group', 0, '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_chat_levels (org_id, agent_id, chat_id, level, level_since)
      VALUES (${orgId}, ${lead}, 'team', 'L1', 0)`;
      const event = {
        _tag: "chat.message",
        orgId,
        agentId: lead,
        eventId: "asked",
        receivedAt: "1970-01-01T00:00:00.000Z",
        dedupeKey: null,
        provenance: { _tag: "human", personId: `owner-${orgId}`, memberId: "member" },
        chatId: "team",
        messageId: "message",
      };
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
      VALUES ('set-turn', ${orgId}, ${lead}, 'model', 0, 'completed', '["asked"]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
      VALUES ('asked', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0, 'done', 'set-turn')`;
      yield* (yield* TriggerService.KinTriggerService).syncItem(asked);
      yield* tick(headsUpAt);
      assert.equal((yield* runOf("def-1"))?.state, "asked");
      assert.include((yield* cardOf("def-1")).text, "starting work isn't open to me here");
      assert.equal(outcome(yield* tap("start_now")), "ok");
      yield* tick(dueAt);
      const [started, ...more] = yield* starts();
      assert.lengthOf(more, 0);
      // The turn that set it up: what the lead does now answers whoever asked there.
      assert.deepStrictEqual(JSON.parse(started!.json).askedIn, ["set-turn"]);
    }).pipe(openGates(new Map()), Effect.provide(layerFor([asked])));
  },
);

// Each action on the asked card, for each person in the owner's chat with the lead.
it.effect.each([
  ["owner", "start_now", "ok", "started"],
  ["owner", "monday", "ok", "armed"],
  ["owner", "cancel", "ok", "undone"],
  ["co-owner", "start_now", "ok", "started"],
  ["co-owner", "monday", "ok", "armed"],
  ["co-owner", "cancel", "ok", "undone"],
  ["member", "start_now", "not_allowed", "asked"],
  ["member", "monday", "not_allowed", "asked"],
  ["member", "cancel", "not_allowed", "asked"],
] as const)("the asked card's %s taps %s: %s", ([role, action, expected, state]) =>
  Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    // Production's stop switch: every due start asks.
    yield* tick(headsUpAt);
    const asked = yield* cardOf("def-1");
    assert.equal(asked.phase, "asked");
    assert.deepStrictEqual(asked.actions, ["start_now", "monday", "cancel"]);
    assert.equal(
      asked.text,
      "def-1 is due at 9:00 am. Tap Start now to start it, Monday to move it, or Cancel. I won't start it on my own: Kin asks before every start for now.",
    );
    if (role !== "owner") yield* joinChat(role, role === "co-owner" ? "co_owner" : "member");
    const person = role === "owner" ? `owner-${orgId}` : role;
    assert.equal(outcome(yield* tap(action, person)), expected);
    assert.equal((yield* runOf("def-1"))?.state, state);
    const [started, ...more] = yield* starts();
    assert.lengthOf(more, 0);
    if (state === "started") {
      assert.deepInclude(JSON.parse(started!.json).provenance, { _tag: "human", personId: person });
      assert.deepInclude(yield* cardOf("def-1"), { phase: "started", actions: [] });
    } else assert.isUndefined(started);
    // A tap Kin finished itself wakes no one.
    const sql = yield* SqlClient.SqlClient;
    const woke = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
      AND tag = 'widget.action'`;
    assert.lengthOf(woke, 0);
  }).pipe(Effect.provide(layerFor([deferral]))),
);

// A lost answer's retry: the same tap again gets the first answer; a second tap is refused.
it.effect.each(["start_now", "monday", "cancel"] as const)(
  "an exact repeat of a committed %s answers as the first did; a double tap is refused",
  (action) =>
    Effect.gen(function* () {
      yield* setup();
      yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
      yield* tick(headsUpAt);
      const chat = yield* Chat.KinChatService;
      const drawn = yield* cardOf("def-1");
      const send = (clientActionId: string) =>
        chat
          .act(
            { _tag: "person", orgId, personId: KinPersonId.make(`owner-${orgId}`) },
            {
              widgetId,
              revision: drawn.revision,
              actionId: action,
              value: "def-1",
              clientActionId,
            },
          )
          .pipe(Effect.result);
      const first = yield* send("tap-1");
      assert.equal(outcome(first), "ok");
      const after = { run: yield* runOf("def-1"), card: yield* cardOf("def-1") };
      const again = yield* send("tap-1");
      assert.equal(
        again._tag === "Success" && again.success.messageId,
        first._tag === "Success" && first.success.messageId,
      );
      assert.equal(outcome(yield* send("tap-2")), "widget_changed");
      assert.deepStrictEqual({ run: yield* runOf("def-1"), card: yield* cardOf("def-1") }, after);
      assert.lengthOf(yield* starts(), action === "start_now" ? 1 : 0);
    }).pipe(Effect.provide(layerFor([deferral]))),
);

it.effect(
  "[Monday] moves the run until memory moves it and asks again then; [Cancel] holds the same way",
  () => {
    const cancelled = makeDeferral("def-2");
    const items = [deferral, cancelled];
    return Effect.gen(function* () {
      yield* setup();
      const service = yield* TriggerService.KinTriggerService;
      for (const entry of items) yield* service.syncItem(entry);
      yield* tick(headsUpAt);

      assert.equal(outcome(yield* tap("monday")), "ok");
      assert.deepStrictEqual(yield* runOf("def-1"), { state: "armed", dueAt: nextMonday });
      const moved = yield* cardOf("def-1");
      assert.isUndefined(moved.phase);
      assert.deepInclude(moved, {
        dueAt: DateTime.formatIso(DateTime.makeUnsafe(nextMonday)),
        actions: ["undo"],
        text: "Deferred to Mon, 16 Nov, 9:00 am. I'll ask you to start it then.",
      });
      assert.equal(outcome(yield* tap("cancel", `owner-${orgId}`, "def-2")), "ok");
      assert.isNotNull(
        Option.getOrThrow(
          yield* (yield* Repository.KinChatRepository).getWidget({
            orgId,
            widgetId: widgetFor("def-2"),
          }),
        ).closedAt,
      );
      assert.deepStrictEqual(yield* triggersOf(), [
        { id: "deferral:def-1:due", enabled: 1, nextRunAt: nextMonday },
        { id: "deferral:def-1:heads_up", enabled: 1, nextRunAt: nextMonday - 30 * 60_000 },
        { id: "deferral:def-2:due", enabled: 0, nextRunAt: null },
        { id: "deferral:def-2:heads_up", enabled: 0, nextRunAt: null },
      ]);
      // Memory still holds Friday: the next syncs keep the move and the cancel.
      for (const entry of items) assert.equal(yield* service.syncItem(entry), "unchanged");
      yield* tick(dueAt);
      assert.lengthOf(yield* starts(), 0);
      assert.equal((yield* runOf("def-2"))?.state, "undone");

      // Monday's heads-up asks again, for Monday.
      yield* tick(nextMonday - 30 * 60_000);
      const again = yield* cardOf("def-1");
      assert.equal(again.phase, "asked");
      assert.equal(again.dueAt, DateTime.formatIso(DateTime.makeUnsafe(nextMonday)));
      assert.equal(outcome(yield* tap("start_now")), "ok");
      const [started] = yield* starts();
      assert.equal(started?.dedupeKey, `deferral:def-1:due:${nextMonday}`);

      // Once memory moves it, memory's time arms again.
      const later = makeDeferral("def-1", { due: "2026-11-20T09:00+05:30" });
      assert.equal(yield* service.syncItem(later), "armed");
      assert.deepStrictEqual(yield* runOf("def-1"), {
        state: "armed",
        dueAt: Date.parse("2026-11-20T03:30:00.000Z"),
      });
    }).pipe(Effect.provide(layerFor(items)));
  },
);

const DECIDE = ["start_now", "monday", "cancel"];
const refusalOf = (result: Effect.Success<ReturnType<typeof tap>>) =>
  result._tag === "Failure" && result.failure._tag === "KinChatError"
    ? result.failure.message
    : undefined;
/** Turns a section off in the company's shell. */
const sectionOff = Effect.fn("test.deferralSectionOff")(function* (section: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
    VALUES (${orgId}, ${JSON.stringify([{ id: section, on: false }])}, 1, ${`owner-${orgId}`}, 0)`;
});

it.effect(
  "a tap on a card drawn before its work changed is refused, and the card is drawn again",
  () => {
    const items = [deferral];
    return Effect.gen(function* () {
      yield* setup();
      yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
      yield* tick(headsUpAt);
      const drawn = yield* cardOf("def-1");
      // Edited in memory with the same due and mode: different work.
      items[0] = makeDeferral("def-1", { title: "Rewrite the importer", what: "Something else" });
      assert.equal(outcome(yield* tap("start_now")), "widget_changed");
      const redrawn = yield* cardOf("def-1");
      assert.isAbove(redrawn.revision, drawn.revision);
      assert.deepInclude(redrawn, {
        phase: "asked",
        title: "Rewrite the importer",
        actions: DECIDE,
      });
      assert.include(redrawn.text, "it changed since you were asked");
      assert.lengthOf(yield* starts(), 0);
      assert.equal((yield* runOf("def-1"))?.state, "asked");
      // The card as drawn now starts the work as it is now.
      assert.equal(outcome(yield* tap("start_now")), "ok");
      assert.lengthOf(yield* starts(), 1);
    }).pipe(Effect.provide(layerFor(items)));
  },
);

it.effect("a tap on an item cancelled in memory is refused and closes its card", () => {
  const items = [deferral];
  return Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    yield* tick(headsUpAt);
    items[0] = makeDeferral("def-1", { status: "cancelled" });
    assert.equal(outcome(yield* tap("monday")), "widget_changed");
    const repo = yield* Repository.KinChatRepository;
    assert.isNotNull(Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId })).closedAt);
    assert.deepStrictEqual(yield* runOf("def-1"), { state: "asked", dueAt });
    assert.lengthOf(yield* starts(), 0);
  }).pipe(Effect.provide(layerFor(items)));
});

it.effect(
  "a link into a section that is off, added after the draw or turned off since, starts nothing",
  () => {
    const items = [makeDeferral("def-1", { links: ["C-1"] }), makeDeferral("def-2")];
    return Effect.gen(function* () {
      yield* setup();
      const service = yield* TriggerService.KinTriggerService;
      for (const entry of items) yield* service.syncItem(entry);
      yield* tick(headsUpAt);
      yield* sectionOff("clients");
      // def-1 was drawn linked to a client; Clients is off now.
      assert.equal(outcome(yield* tap("start_now")), "invalid_state");
      // def-2 is linked to a client after its card was drawn.
      items[1] = makeDeferral("def-2", { links: ["C-1"] });
      assert.equal(outcome(yield* tap("start_now", `owner-${orgId}`, "def-2")), "widget_changed");
      assert.equal(outcome(yield* tap("start_now", `owner-${orgId}`, "def-2")), "invalid_state");
      assert.lengthOf(yield* starts(), 0);
      assert.deepStrictEqual(
        [(yield* runOf("def-1"))?.state, (yield* runOf("def-2"))?.state],
        ["asked", "asked"],
      );
    }).pipe(Effect.provide(layerFor(items)));
  },
);

it.effect("a paused agent is not started: refused at the tap, and held at the claim", () =>
  Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    yield* tick(headsUpAt);
    assert.equal((yield* cardOf("def-1")).agent, "Lead");
    const sql = yield* SqlClient.SqlClient;
    const pause = (at: number | null) =>
      sql`UPDATE kin_agents SET paused_at = ${at} WHERE org_id = ${orgId} AND agent_id = ${`lead-${orgId}`}`;
    yield* pause(1);
    const paused = yield* tap("start_now");
    assert.equal(outcome(paused), "invalid_state");
    assert.equal(refusalOf(paused), "Lead is paused. Resume it, then start this.");
    assert.equal((yield* runOf("def-1"))?.state, "asked");
    assert.lengthOf(yield* starts(), 0);

    yield* pause(null);
    assert.equal(outcome(yield* tap("start_now")), "ok");
    assert.deepInclude(yield* cardOf("def-1"), { text: "Asked Lead to start it.", agent: "Lead" });
    // Paused between the tap and its turn: nothing is claimed until it is resumed.
    yield* pause(2);
    const queue = yield* Queue.KinEventQueue;
    const claim = yield* Effect.scoped(
      queue.claim({
        orgId,
        agentId: KinAgentId.make(`lead-${orgId}`),
        wakeupId: KinWakeupId.make("wake-paused"),
        model: "fixture",
      }),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("10 minutes");
    assert.isUndefined(claim.pollUnsafe());
    const [queued] = yield* sql<{ state: string }>`SELECT state FROM kin_events
      WHERE org_id = ${orgId} AND tag = 'deferral.due' ORDER BY event_id`;
    assert.equal(queued?.state, "queued");
    yield* Fiber.interrupt(claim);
  }).pipe(Effect.provide(layerFor([deferral]))),
);

// A card the earlier build drew: no taps listed, no source kept with its run.
it.effect.each(["start_now", "monday", "cancel"] as const)(
  "an asked card from before taps were bound is drawn again at start-up, then takes %s",
  (action) =>
    Effect.gen(function* () {
      yield* setup();
      yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
      yield* tick(headsUpAt);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_deferral_runs SET snapshot_json =
          json_remove(snapshot_json, '$.drawn', '$.source')
        WHERE org_id = ${orgId} AND item_id = 'def-1'`;
      yield* sql`UPDATE kin_widgets SET state_json =
          json_remove(state_json, '$.actions', '$.agent'), revision = revision + 1
        WHERE org_id = ${orgId} AND widget_id = ${widgetId}`;
      const old = yield* cardOf("def-1");
      assert.isUndefined(old.actions);
      assert.equal(outcome(yield* tap(action)), "widget_changed");
      // The deferral tick draws it again from its committed item.
      yield* tick(headsUpAt + 60_000);
      const redrawn = yield* cardOf("def-1");
      assert.isAbove(redrawn.revision, old.revision);
      assert.deepInclude(redrawn, { phase: "asked", actions: DECIDE, agent: "Lead" });
      // The old revision gains nothing.
      const chat = yield* Chat.KinChatService;
      const stale = yield* chat
        .act(
          { _tag: "person", orgId, personId: KinPersonId.make(`owner-${orgId}`) },
          {
            widgetId,
            revision: old.revision,
            actionId: action,
            value: "def-1",
            clientActionId: "old",
          },
        )
        .pipe(Effect.result);
      assert.equal(outcome(stale), "widget_changed");
      assert.equal(outcome(yield* tap(action)), "ok");
      assert.equal(
        (yield* runOf("def-1"))?.state,
        action === "start_now" ? "started" : action === "monday" ? "armed" : "undone",
      );
    }).pipe(Effect.provide(layerFor([deferral]))),
);

it.effect("a card with no agent to start it lists Monday and Cancel, and says so", () =>
  Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_agents SET retired_at = 1 WHERE org_id = ${orgId}`;
    yield* tick(headsUpAt);
    const asked = yield* cardOf("def-1");
    assert.deepStrictEqual(asked.actions, ["monday", "cancel"]);
    assert.include(asked.text, "Tap Monday to move it, or Cancel. I can't start it now:");
    assert.include(asked.text, "there is no active agent");
    assert.equal(outcome(yield* tap("start_now")), "widget_changed");
  }).pipe(Effect.provide(layerFor([deferral]))),
);

it.effect("a retired agent's card starts with a live fallback, and refuses without one", () =>
  Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    yield* tick(headsUpAt);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_agents SET retired_at = 1 WHERE org_id = ${orgId}
      AND agent_id = ${`lead-${orgId}`}`;
    assert.equal(outcome(yield* tap("start_now")), "invalid_state");
    assert.equal((yield* runOf("def-1"))?.state, "asked");
    yield* addLead(orgId, "lead-fallback", "engineering", "2026-11-07T00:00:00.000Z");
    assert.equal(outcome(yield* tap("start_now")), "ok");
    const [started] = yield* starts();
    assert.equal(JSON.parse(started!.json).agentId, "lead-fallback");
  }).pipe(Effect.provide(layerFor([deferral]))),
);

it.effect("taps that aren't this card's are refused and change nothing", () => {
  const foreign = makeDeferral("def-b", { orgId: otherOrg, chat: KinChatId.make("chat-b") });
  return Effect.gen(function* () {
    yield* setup();
    const service = yield* TriggerService.KinTriggerService;
    yield* service.syncItem(deferral);
    yield* service.syncItem(foreign);
    yield* tick(headsUpAt);
    const sql = yield* SqlClient.SqlClient;
    const before = { run: yield* runOf("def-1"), card: yield* cardOf("def-1") };
    // Another item's id on this card.
    assert.equal(
      outcome(yield* tap("monday", `owner-${orgId}`, "def-2", widgetId)),
      "invalid_state",
    );
    // Another company's card.
    assert.equal(
      outcome(
        yield* tap(
          "monday",
          `owner-${orgId}`,
          "def-b",
          KinWidgetId.make(`deferral:${otherOrg}:def-b`),
        ),
      ),
      "not_found",
    );
    // A guest co-owner, and a co-owner who left the chat.
    yield* joinChat("guest-a", "co_owner");
    yield* sql`UPDATE kin_chat_members SET role = 'guest' WHERE member_id = 'member-guest-a'`;
    yield* joinChat("gone-a", "co_owner");
    yield* sql`UPDATE kin_chat_members SET left_at = '2026-11-08T00:00:00.000Z'
      WHERE member_id = 'member-gone-a'`;
    for (const person of ["guest-a", "gone-a"])
      assert.notEqual(outcome(yield* tap("cancel", person)), "ok", person);
    assert.deepStrictEqual({ run: yield* runOf("def-1"), card: yield* cardOf("def-1") }, before);
    assert.lengthOf(yield* starts(), 0);
  }).pipe(Effect.provide(layerFor([deferral, foreign])));
});

it.effect("once only: the due fire starts first, and the card drawn before it refuses", () =>
  Effect.gen(function* () {
    yield* setup();
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    yield* tick(headsUpAt);
    const headsUp = yield* cardOf("def-1");
    assert.equal(headsUp.phase, "heads_up");
    yield* tick(dueAt);
    assert.equal((yield* runOf("def-1"))?.state, "started");
    const chat = yield* Chat.KinChatService;
    const stale = yield* chat
      .act(
        { _tag: "person", orgId, personId: KinPersonId.make(`owner-${orgId}`) },
        {
          widgetId,
          revision: headsUp.revision,
          actionId: "start_now",
          value: "def-1",
          clientActionId: "late",
        },
      )
      .pipe(Effect.result);
    assert.equal(outcome(stale), "widget_changed");
    assert.lengthOf(yield* starts(), 1);
  }).pipe(openGates(new Map()), Effect.provide(layerFor([deferral]))),
);

it.effect("Monday twice moves once; Cancel then Start now starts nothing", () => {
  const items = [deferral, makeDeferral("def-2")];
  return Effect.gen(function* () {
    yield* setup();
    const service = yield* TriggerService.KinTriggerService;
    for (const entry of items) yield* service.syncItem(entry);
    yield* tick(headsUpAt);
    assert.equal(outcome(yield* tap("monday")), "ok");
    assert.equal(outcome(yield* tap("monday")), "widget_changed");
    assert.deepStrictEqual(yield* runOf("def-1"), { state: "armed", dueAt: nextMonday });
    assert.equal(outcome(yield* tap("cancel", `owner-${orgId}`, "def-2")), "ok");
    assert.notEqual(outcome(yield* tap("start_now", `owner-${orgId}`, "def-2")), "ok");
    assert.equal((yield* runOf("def-2"))?.state, "undone");
    assert.lengthOf(yield* starts(), 0);
  }).pipe(Effect.provide(layerFor(items)));
});

it.effect(
  "after [Monday], memory's change of mode at the old time is a full replan that fires",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const service = yield* TriggerService.KinTriggerService;
      yield* service.syncItem(deferral);
      yield* tick(headsUpAt);
      assert.equal(outcome(yield* tap("monday")), "ok");
      assert.equal(yield* service.syncItem(deferral), "unchanged");
      // Memory now asks instead of starting, at the same Friday time.
      const asking = makeDeferral("def-1", { on_due: "ask" });
      assert.equal(yield* service.syncItem(asking), "armed");
      assert.deepStrictEqual(yield* runOf("def-1"), { state: "armed", dueAt });
      assert.deepStrictEqual(yield* triggersOf(), [
        { id: "deferral:def-1:due", enabled: 1, nextRunAt: dueAt },
        { id: "deferral:def-1:heads_up", enabled: 0, nextRunAt: null },
      ]);
      yield* tick(dueAt);
      assert.equal((yield* runOf("def-1"))?.state, "asked");
      // Nothing is left pointing at Monday.
      yield* tick(nextMonday);
      assert.deepStrictEqual(yield* runOf("def-1"), { state: "asked", dueAt });
    }).pipe(Effect.provide(layerFor([deferral]))),
);

it.effect("a cancelled run stays cancelled while its item is away and when it comes back", () => {
  const items = [deferral];
  return Effect.gen(function* () {
    yield* setup();
    const service = yield* TriggerService.KinTriggerService;
    yield* service.syncItem(deferral);
    yield* tick(headsUpAt);
    assert.equal(outcome(yield* tap("cancel")), "ok");
    yield* service.syncOrg(orgId, []);
    assert.equal((yield* runOf("def-1"))?.state, "undone");
    yield* service.syncOrg(orgId, items);
    assert.equal((yield* runOf("def-1"))?.state, "undone");
    yield* tick(dueAt);
    assert.lengthOf(yield* starts(), 0);
    assert.equal((yield* runOf("def-1"))?.state, "undone");
    // Only a new due arms it again.
    yield* service.syncOrg(orgId, [makeDeferral("def-1", { due: "2026-11-20T09:00+05:30" })]);
    assert.equal((yield* runOf("def-1"))?.state, "armed");
  }).pipe(Effect.provide(layerFor(items)));
});

it.effect("an Undo after [Monday] holds; a tap on a card drawn before a change is refused", () =>
  Effect.gen(function* () {
    yield* setup();
    const service = yield* TriggerService.KinTriggerService;
    yield* service.syncItem(deferral);
    yield* tick(headsUpAt);
    const asked = yield* cardOf("def-1");
    assert.equal(outcome(yield* tap("monday")), "ok");
    // The screen still shows the asked card: its taps say the card changed.
    const chat = yield* Chat.KinChatService;
    const stale = yield* chat
      .act(
        { _tag: "person", orgId, personId: KinPersonId.make(`owner-${orgId}`) },
        {
          widgetId,
          revision: asked.revision,
          actionId: "start_now",
          value: "def-1",
          clientActionId: "stale-start",
        },
      )
      .pipe(Effect.result);
    assert.equal(outcome(stale), "widget_changed");
    assert.equal(outcome(yield* tap("undo")), "ok");
    assert.equal((yield* runOf("def-1"))?.state, "undone");
    assert.equal(yield* service.syncItem(deferral), "unchanged");
    yield* tick(nextMonday);
    assert.lengthOf(yield* starts(), 0);
  }).pipe(Effect.provide(layerFor([deferral]))),
);

it.effect("the owner's Start now starts at L1", () =>
  Effect.gen(function* () {
    yield* setup("L1");
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    yield* tick(headsUpAt);
    assert.equal((yield* runOf("def-1"))?.state, "asked");
    assert.equal(outcome(yield* tap("start_now")), "ok");
    assert.equal((yield* runOf("def-1"))?.state, "started");
    const [started] = yield* starts();
    assert.include(started!.json, '"_tag":"human"');
  }).pipe(openGates(new Map()), Effect.provide(layerFor([deferral]))),
);

// The agent's owner in its chat, but a teammate in the company: owning the chat grants nothing.
it.effect("a teammate who owns the chat can't Start now, Monday or Cancel", () =>
  Effect.gen(function* () {
    yield* setup("L1");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_people SET access = 'member' WHERE org_id = ${orgId}
      AND person_id = ${`owner-${orgId}`}`;
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    yield* tick(headsUpAt);
    const before = { run: yield* runOf("def-1"), triggers: yield* triggersOf() };
    for (const action of ["start_now", "monday", "cancel"])
      assert.equal(outcome(yield* tap(action)), "not_allowed", action);
    assert.deepStrictEqual({ run: yield* runOf("def-1"), triggers: yield* triggersOf() }, before);
    assert.equal(before.run?.state, "asked");
    assert.lengthOf(yield* starts(), 0);
  }).pipe(openGates(new Map()), Effect.provide(layerFor([deferral]))),
);

it.effect("a co-owner demoted to member can't Undo the card they set", () =>
  Effect.gen(function* () {
    yield* setup();
    yield* joinChat("co-a", "co_owner");
    yield* (yield* TriggerService.KinTriggerService).syncItem(deferral);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_people SET access = 'member' WHERE org_id = ${orgId}
      AND person_id = 'co-a'`;
    assert.equal(outcome(yield* tap("undo", "co-a")), "not_allowed");
    assert.deepStrictEqual(yield* runOf("def-1"), { state: "armed", dueAt });
  }).pipe(Effect.provide(layerFor([deferral]))),
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
      assert.include(asked, "This was due at 9:00 am.");

      assert.equal((yield* runOf("def-2"))?.state, "grace");
      const grace = yield* cardOf("def-2");
      assert.equal(grace.phase, "heads_up");
      assert.equal(grace.text, "Starting def-2 at 10:45 am. This was due at 10:00 am.");
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
    assert.lengthOf(yield* handedReminders(), 0);

    yield* tick(Date.parse("2026-11-14T03:30:00.000Z"));
    assert.deepStrictEqual(
      (yield* handedReminders()).map((row) => row.itemId),
      ["def-2"],
    );
  }).pipe(openGates(new Map()), Effect.provide(layerFor(items)));
});

it.effect(
  "an Undo or a lead's cancel disarms it before due; a late or outsider Undo is refused",
  () => {
    const undone = makeDeferral("def-u");
    const late = makeDeferral("def-l");
    const cancelled = makeDeferral("def-c", { on_due: "remind" });
    const firing = makeDeferral("def-f", { on_due: "remind" });
    const items = [undone, late, cancelled, firing];
    return Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      const chat = yield* Chat.KinChatService;
      const service = yield* TriggerService.KinTriggerService;
      for (const entry of items) yield* service.syncItem(entry);
      // A remind deferral posts no "Deferred to …" card: the lead's own reply says when.
      assert.isTrue(Option.isNone(yield* repo.getWidget({ orgId, widgetId: widgetFor("def-c") })));
      const cancel = (itemId: string) =>
        sql.withTransaction(
          TriggerService.cancelDeferralRun({
            orgId,
            itemId: KinMemoryItemId.make(itemId),
            now: headsUpAt,
          }),
        );
      assert.isTrue(yield* cancel("def-c"));
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('outsider-a', ${orgId}, 'outsider', 'Outsider', 0)`;
      const undo = (personId: string, itemId: string) =>
        Effect.gen(function* () {
          const widget = Option.getOrThrow(
            yield* repo.getWidget({ orgId, widgetId: widgetFor(itemId) }),
          );
          return yield* chat
            .act(
              { _tag: "person", orgId, personId: KinPersonId.make(personId) },
              {
                widgetId: widget.widgetId,
                revision: widget.revision,
                actionId: "undo",
                value: itemId,
                clientActionId: `undo-${personId}-${itemId}`,
              },
            )
            .pipe(Effect.result);
        });
      const reason = (result: Effect.Success<ReturnType<typeof undo>>) =>
        result._tag === "Failure" && result.failure._tag === "KinChatError"
          ? result.failure.reason
          : result._tag;

      assert.notEqual(reason(yield* undo("outsider-a", "def-u")), "Success");
      assert.equal((yield* runOf("def-u"))?.state, "armed");

      assert.equal(reason(yield* undo("owner-a", "def-u")), "Success");
      assert.equal((yield* runOf("def-u"))?.state, "undone");
      assert.isNotNull(
        Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId: widgetFor("def-u") })).closedAt,
      );
      // Memory still says open until the lead records the cancel; the Undo holds meanwhile.
      assert.equal(yield* service.syncItem(undone), "unchanged");
      assert.equal(yield* service.syncItem(cancelled), "unchanged");

      // def-f's fire is already queued when the lead cancels it: the drain drops it.
      yield* TestClock.setTime(dueAt);
      yield* (yield* TriggerScheduler.KinTriggerScheduler).runDue();
      assert.isTrue(yield* cancel("def-f"));
      yield* tick(dueAt);
      assert.lengthOf(yield* handedReminders(), 0);
      assert.lengthOf(yield* pendingFires(), 0);
      assert.equal((yield* runOf("def-l"))?.state, "asked");
      assert.isFalse(yield* cancel("def-l-missing"));

      assert.equal(reason(yield* undo("owner-a", "def-l")), "invalid_state");
      assert.equal((yield* runOf("def-l"))?.state, "asked");
      // Once memory records the cancel, the run disarms and stays quiet.
      assert.equal(yield* service.syncItem({ ...cancelled, status: "cancelled" }), "disarmed");
      yield* tick(dueAt + 60 * 60_000);
      assert.lengthOf(yield* handedReminders(), 0);
    }).pipe(Effect.provide(layerFor(items)));
  },
);

it.effect("held invoice reminders stay queued without blocking later reminders", () => {
  const held = Array.from({ length: 150 }, (_, i) =>
    makeDeferral(`def-r-${i}`, { title: "Follow up on INV-1", on_due: "remind" }),
  );
  const live = makeDeferral("def-z", {
    title: "Check the samples",
    on_due: "remind",
    due: "2026-11-13T09:01+05:30",
  });
  const items = [...held, live];
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
      VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0)`;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
      owner_id, created_by_kind, origin_key, created_at, updated_at, fields_json)
      VALUES (${orgId}, 'invoice', 'invoices', 'INV-1', 'Invented invoice', 'person',
        'owner', 'person', 'invoice', 0, 0, '{}')`;
    const service = yield* TriggerService.KinTriggerService;
    for (const item of items) yield* service.syncItem(item);
    yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
      VALUES (${orgId}, '[{"id":"money","on":false}]', 1, 'owner', 0)`;
    const threeDays = 3 * 24 * 60 * 60_000;
    yield* tick(dueAt);
    yield* tick(dueAt + 60_000);
    assert.deepStrictEqual(yield* handedReminders(), [{ itemId: live.id, lateByMs: 0 }]);
    yield* tick(dueAt + threeDays);
    assert.lengthOf(yield* handedReminders(), 1);
    assert.lengthOf(yield* pendingFires(), 150);
    yield* sql`UPDATE kin_company_shell SET shell_json = '[]', rev = 2 WHERE org_id = ${orgId}`;
    yield* tick(dueAt + threeDays + 60_000);
    yield* tick(dueAt + threeDays + 120_000);
    yield* tick(dueAt + threeDays + 180_000);
    const delivered = yield* handedReminders();
    assert.deepStrictEqual(
      delivered.map(({ itemId }) => itemId).toSorted(),
      items.map(({ id }) => id).toSorted(),
    );
    assert.isTrue(
      delivered
        .filter(({ itemId }) => itemId !== live.id)
        .every(({ lateByMs }) => lateByMs > threeDays),
    );
    assert.lengthOf(yield* pendingFires(), 0);
  }).pipe(Effect.provide(layerFor(items)));
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
    const [reminder] = yield* handedReminders();
    assert.equal(reminder?.itemId, "def-r");
    assert.isAbove(reminder?.lateByMs ?? 0, 10 * 60_000);
    assert.isTrue(
      messages.some(({ body }) =>
        body.includes("def-c was due Fri, 13 Nov, 9:00 am. What's the status?"),
      ),
    );
    assert.equal((yield* runOf("def-r"))?.state, "reminded");
    assert.equal((yield* runOf("def-a"))?.state, "asked");
    const asked = yield* cardOf("def-a");
    assert.equal(asked.phase, "asked");
    assert.include(asked.text, "This was due at 9:00 am.");
    assert.equal((yield* runOf("def-c"))?.state, "chased");
    const ledger =
      yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY item_id`;
    assert.lengthOf(ledger, 2);
    assert.lengthOf(yield* starts(), 0);

    // A fire that can't be handled is consumed after telling the owner.
    assert.isTrue(
      messages.some(
        ({ body }) => body === "I couldn't handle the deferral def-x due Fri, 13 Nov, 9:00 am.",
      ),
    );
    assert.equal((yield* runOf("def-x"))?.state, "armed");
    assert.lengthOf(yield* pendingFires(), 0);
  }).pipe(Effect.provide(layerFor(items)));
});

it.effect(
  "a due promise to ask a third person wakes the holding agent and posts no card to the asker; ask me still posts the card",
  () => {
    const zoya = makeDeferral("def-z", { on_due: "ask", owner: "zoya", said_by: "owner" });
    const me = makeDeferral("def-m", { on_due: "ask", owner: "owner", said_by: "owner" });
    const items = [zoya, me];
    return Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('zoya-a', ${orgId}, 'zoya', 'Zoya', '2026-09-01T00:00:00.000Z')`;
      const service = yield* TriggerService.KinTriggerService;
      for (const entry of items) yield* service.syncItem(entry);
      yield* tick(dueAt);

      assert.equal((yield* runOf("def-z"))?.state, "started");
      const handed = (yield* starts()).map((row) => decodeEvent(JSON.parse(row.json)));
      assert.deepStrictEqual(
        handed.map((event) => (event._tag === "deferral.due" ? event.subject : undefined)),
        [{ type: "deferral", itemId: KinMemoryItemId.make("def-z"), phase: "due" }],
      );
      assert.deepStrictEqual(
        handed.map((event) => event.agentId),
        [KinAgentId.make("lead-a")],
      );
      assert.isTrue(Option.isNone(yield* repo.getWidget({ orgId, widgetId: widgetFor("def-z") })));

      assert.equal((yield* runOf("def-m"))?.state, "asked");
      assert.equal((yield* cardOf("def-m")).phase, "asked");
    }).pipe(Effect.provide(layerFor(items)));
  },
);

const reminderEvent = Effect.fn("test.reminderEvent")(function* (index = 0) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId" FROM kin_events
    WHERE org_id = ${orgId} AND json_extract(json, '$.subject.type') = 'reminder'
    ORDER BY received_at, event_id`;
  return rows[index]!.eventId;
});
const reminderCard = Effect.fn("test.reminderCard")(function* (itemId: string, at: number) {
  const repo = yield* Repository.KinChatRepository;
  const widgetId = KinWidgetId.make(kinReminderWidgetId(orgId, itemId, at));
  return Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId }));
});
const owner = { _tag: "person", orgId, personId: KinPersonId.make("owner-a") } as const;

it.effect(
  "a due reminder is one message with its card; Snooze re-arms it and Done ends it without the lead",
  () => {
    const remind = makeDeferral("def-r", { on_due: "remind" });
    return Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const deliveries = yield* LeadDelivery.KinLeadDelivery;
      yield* (yield* TriggerService.KinTriggerService).syncItem(remind);
      yield* tick(dueAt);

      const messageId = yield* leadWakeup({
        orgId,
        eventId: yield* reminderEvent(),
        chatId: "chat-a",
        body: "Still on for def-r: the invoice went out yesterday, so this is the follow-up.",
      });
      yield* deliveries.settle(orgId);
      const card = yield* reminderCard("def-r", dueAt);
      assert.equal(card.messageId, messageId);
      assert.deepInclude(card.state, { status: "due", itemId: "def-r" });
      // One reminder, one message: no "Deferred to …" row at arming and no Kin line at due.
      const posted = yield* sql<{ messageId: string }>`SELECT message_id AS "messageId"
      FROM kin_messages WHERE org_id = ${orgId} AND chat_id = 'chat-a' ORDER BY seq`;
      assert.deepStrictEqual(
        posted.map((row) => row.messageId),
        [messageId],
      );

      const tappedAt = yield* Clock.currentTimeMillis;
      yield* (yield* Chat.KinChatService).act(owner, {
        widgetId: card.widgetId,
        revision: card.revision,
        actionId: "snooze_10m",
        value: "def-r",
        clientActionId: "snooze-def-r",
      });
      assert.equal((yield* runOf("def-r"))?.state, "snoozed");
      assert.deepInclude((yield* reminderCard("def-r", dueAt)).state, { status: "snoozed" });
      yield* tick(tappedAt + 5 * 60_000);
      assert.lengthOf(yield* handedReminders(), 1);
      yield* tick(tappedAt + 10 * 60_000);
      assert.lengthOf(yield* handedReminders(), 2);
      assert.equal((yield* runOf("def-r"))?.state, "reminded");

      const chat = yield* Chat.KinChatService;
      const snoozed = yield* reminderCard("def-r", dueAt);
      const done = {
        widgetId: snoozed.widgetId,
        revision: snoozed.revision,
        actionId: "done",
        value: "def-r",
        clientActionId: "done-def-r",
      };
      const tapped = yield* chat.act(owner, done);
      // The server finished Done, so ChatWake raises no widget.action for the lead.
      assert.deepInclude(JSON.parse(tapped.body), { actionId: "done", handled: true });
      assert.equal((yield* runOf("def-r"))?.state, "done");
      const finished = yield* reminderCard("def-r", dueAt);
      assert.deepInclude(finished.state, { status: "done" });
      // A double tap: the same tap returns the same message; a second one is refused.
      assert.equal((yield* chat.act(owner, done)).messageId, tapped.messageId);
      const again = yield* chat
        .act(owner, { ...done, revision: finished.revision, clientActionId: "done-def-r-2" })
        .pipe(Effect.flip);
      assert.equal(again._tag === "KinChatError" && again.reason, "invalid_state");
      yield* tick(tappedAt + 24 * 60 * 60_000);
      assert.lengthOf(yield* handedReminders(), 2);
    }).pipe(Effect.provide(layerFor([remind])));
  },
);

// Fifth review of cfb0c8993b: a reminder an owner-only turn set stays the owner's after a join.
it.effect("a reminder set privately in a group later shared fires into the owner's chat", () => {
  const remind = makeDeferral("def-g", {
    on_due: "remind",
    chat: KinChatId.make("group-a"),
    source_event: KinEventId.make("set-event"),
  });
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* Repository.KinChatRepository;
    const lead = KinAgentId.make(`lead-${orgId}`);
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
      VALUES ('group-a', ${orgId}, 'team_group', 'Plans', 0, '1970-01-01T00:00:00.000Z')`;
    const join = (
      memberId: string,
      principal: Parameters<typeof repo.addMember>[0]["principal"],
      role: "owner" | "member" = "member",
    ) =>
      repo.addMember({
        orgId,
        chatId: KinChatId.make("group-a"),
        memberId: KinMemberId.make(memberId),
        principal,
        role,
        joinedAt: "1970-01-01T00:00:00.000Z",
        leftAt: null,
        mutedUntil: null,
      });
    yield* join(
      "group-owner",
      { _tag: "person", personId: KinPersonId.make(`owner-${orgId}`) },
      "owner",
    );
    yield* join("group-lead", { _tag: "agent", agentId: lead });
    // The owner asked for it in the group while only they read there: an owner-only turn.
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
        event_ids, audience) VALUES ('set-wake', ${orgId}, ${lead}, 'test', 0, 'completed',
        '["set-event"]', 'owner_only')`;
    const asked = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId: "set-event",
      receivedAt: "1970-01-01T00:00:00.000Z",
      dedupeKey: null,
      provenance: { _tag: "human", personId: `owner-${orgId}`, memberId: "group-owner" },
      chatId: "group-a",
      messageId: "set-message",
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, wakeup_id)
      VALUES ('set-event', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(asked)}, 0, 0,
        'done', 'set-wake')`;
    yield* (yield* TriggerService.KinTriggerService).syncItem(remind);
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', '1970-01-01T00:00:00.000Z')`;
    yield* join("group-teammate", { _tag: "person", personId: KinPersonId.make("teammate") });
    yield* tick(dueAt);

    const eventId = yield* reminderEvent();
    const [due] = yield* sql<{
      json: string;
    }>`SELECT json FROM kin_events WHERE event_id = ${eventId}`;
    assert.notProperty(JSON.parse(due!.json), "origin");
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
        event_ids) VALUES ('fire-wake', ${orgId}, ${lead}, 'test', 0, 'running', json_array(${eventId}))`;
    yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'fire-wake' WHERE event_id = ${eventId}`;
    const turn = { orgId, agentId: lead, wakeupId: KinWakeupId.make("fire-wake") };
    assert.equal(yield* turnAudience(turn), "owner_only");
    assert.deepInclude(Option.getOrThrow(yield* laneFor(turn)), {
      chatId: KinChatId.make(`chat-${orgId}`),
    });
    yield* sql`UPDATE kin_events SET state = 'queued', wakeup_id = NULL WHERE event_id = ${eventId}`;
    yield* sql`DELETE FROM kin_wakeups WHERE wakeup_id = 'fire-wake'`;
    yield* leadWakeup({ orgId, eventId, chatId: `chat-${orgId}`, body: "Your reminder." });
    yield* (yield* LeadDelivery.KinLeadDelivery).settle(orgId);
    assert.equal((yield* reminderCard("def-g", dueAt)).chatId, `chat-${orgId}`);
    const inGroup =
      yield* sql`SELECT 1 FROM kin_messages m JOIN kin_chats c ON c.chat_id = m.chat_id
      WHERE m.chat_id = 'group-a' AND m.seq >= c.shared_from_seq`;
    assert.lengthOf(inGroup, 0);
  }).pipe(Effect.provide(layerFor([remind])));
});

it.effect("a group's own reminder fires into the group as its agent, else to whoever asked", () => {
  const here = makeDeferral("def-s", {
    on_due: "remind",
    chat: KinChatId.make("group-a"),
    source_event: KinEventId.make("set-event"),
    said_by: "teammate",
    for_chat: true,
  });
  const partners = makeDeferral("def-c", {
    on_due: "remind",
    due: "2026-11-13T11:00+05:30",
    chat: KinChatId.make("group-a"),
    source_event: KinEventId.make("set-event"),
    said_by: "teammate",
    for_chat: true,
  });
  // Its asker undoes this one themselves.
  const theirs = makeDeferral("def-t", {
    on_due: "remind",
    due: "2026-11-13T11:30+05:30",
    chat: KinChatId.make("group-a"),
    source_event: KinEventId.make("set-event"),
    said_by: "teammate",
    for_chat: true,
  });
  // Due after someone joined who couldn't read where it was set; and one asked by Bystander, who
  // has no chat with the agent.
  const late = makeDeferral("def-w", {
    on_due: "remind",
    due: "2026-11-13T09:30+05:30",
    chat: KinChatId.make("group-a"),
    source_event: KinEventId.make("set-event"),
    said_by: "teammate",
    for_chat: true,
  });
  const unreached = makeDeferral("def-u", {
    on_due: "remind",
    due: "2026-11-13T10:30+05:30",
    chat: KinChatId.make("group-a"),
    source_event: KinEventId.make("set-event"),
    said_by: "bystander",
    for_chat: true,
  });
  const gone = makeDeferral("def-m", {
    on_due: "remind",
    due: "2026-11-13T10:00+05:30",
    chat: KinChatId.make("group-a"),
    source_event: KinEventId.make("set-event"),
    said_by: "teammate",
    for_chat: true,
  });
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* Repository.KinChatRepository;
    const lead = KinAgentId.make(`lead-${orgId}`);
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES
      ('teammate', ${orgId}, 'teammate', 'Teammate', '1970-01-01T00:00:00.000Z'),
      ('bystander', ${orgId}, 'bystander', 'Bystander', '1970-01-01T00:00:00.000Z'),
      ('latecomer', ${orgId}, 'latecomer', 'Latecomer', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES ('partner', ${orgId}, 'partner', 'Partner', '1970-01-01T00:00:00.000Z', 'co_owner')`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at, direct_key)
      VALUES ('group-a', ${orgId}, 'team_group', 'Plans', 0, '1970-01-01T00:00:00.000Z', NULL),
        ('teammate-direct', ${orgId}, 'direct', NULL, 0, '1970-01-01T00:00:00.000Z',
          ${`teammate:${lead}`})`;
    const join = (
      chatId: string,
      memberId: string,
      principal: Parameters<typeof repo.addMember>[0]["principal"],
      role: "owner" | "member" = "member",
    ) =>
      repo.addMember({
        orgId,
        chatId: KinChatId.make(chatId),
        memberId: KinMemberId.make(memberId),
        principal,
        role,
        joinedAt: "1970-01-01T00:00:00.000Z",
        leftAt: null,
        mutedUntil: null,
      });
    const person = (id: string) => ({ _tag: "person", personId: KinPersonId.make(id) }) as const;
    yield* join("group-a", "group-owner", person(`owner-${orgId}`), "owner");
    yield* join("group-a", "group-lead", { _tag: "agent", agentId: lead });
    yield* join("group-a", "group-teammate", person("teammate"));
    yield* join("group-a", "group-bystander", person("bystander"));
    // A co-owner who is a plain member of the group, and did not ask.
    yield* join("group-a", "group-partner", person("partner"));
    yield* join("teammate-direct", "direct-teammate", person("teammate"));
    yield* join("teammate-direct", "direct-lead", { _tag: "agent", agentId: lead });
    // The teammate asked in the group, which everyone there read: a shared turn.
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
        event_ids, audience) VALUES ('set-wake', ${orgId}, ${lead}, 'test', 0, 'completed',
        '["set-event"]', 'shared')`;
    const asked = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId: "set-event",
      receivedAt: "1970-01-01T00:00:00.000Z",
      dedupeKey: null,
      provenance: { _tag: "human", personId: "teammate", memberId: "group-teammate" },
      chatId: "group-a",
      messageId: "set-message",
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, wakeup_id)
      VALUES ('set-event', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(asked)}, 0, 0,
        'done', 'set-wake')`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES ('set-message', ${orgId}, 'group-a', 1, 'human', 'teammate', 'group-teammate',
        'member', 'text', 'remind us to send the report', '[]', 'posted', '1970-01-01T00:00:00.000Z')`;
    yield* sql`UPDATE kin_chats SET last_seq = 1 WHERE chat_id = 'group-a'`;
    const triggers = yield* TriggerService.KinTriggerService;
    yield* triggers.syncItem(here);
    yield* triggers.syncItem(gone);
    yield* triggers.syncItem(partners);
    yield* triggers.syncItem(theirs);
    yield* triggers.syncItem(late);
    yield* triggers.syncItem(unreached);

    // Everyone there sees it, with who asked; only they, the owner or a co-owner stop it.
    const set = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId: widgetFor("def-s") }));
    assert.equal(set.chatId, "group-a");
    assert.deepStrictEqual((yield* cardOf("def-s")).askedBy, {
      personId: KinPersonId.make("teammate"),
      name: "Teammate",
    });
    const chat = yield* Chat.KinChatService;
    const undo = (personId: string, itemId = "def-m") =>
      chat.act(
        { _tag: "person", orgId, personId: KinPersonId.make(personId) },
        {
          widgetId: widgetFor(itemId),
          revision: 1,
          actionId: "undo",
          value: itemId,
          clientActionId: `undo-${personId}`,
        },
      );
    const refused = yield* undo("bystander").pipe(Effect.flip);
    assert.deepInclude(refused, { reason: "not_allowed", message: KIN_ASKER_ONLY_REFUSAL });
    yield* undo("partner", "def-c");
    assert.strictEqual((yield* runOf("def-c"))?.state, "undone");
    // The asker may Undo their own; any other tap from them is the company's, so refused.
    const forged = yield* chat
      .act(
        { _tag: "person", orgId, personId: KinPersonId.make("teammate") },
        {
          widgetId: widgetFor("def-t"),
          revision: 1,
          actionId: "monday",
          value: "def-t",
          clientActionId: "forged-monday",
        },
      )
      .pipe(Effect.flip);
    assert.deepInclude(forged, { reason: "not_allowed" });
    assert.strictEqual((yield* runOf("def-t"))?.state, "armed");
    yield* undo("teammate", "def-t");
    assert.strictEqual((yield* runOf("def-t"))?.state, "undone");

    yield* tick(dueAt);
    const eventId = yield* reminderEvent();
    const [due] = yield* sql<{
      json: string;
    }>`SELECT json FROM kin_events WHERE event_id = ${eventId}`;
    assert.deepInclude(JSON.parse(due!.json), {
      chatId: "group-a",
      origin: { agentId: lead, chatId: "group-a" },
    });
    // Read by who is in the group when it fires, not when it was set.
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
        event_ids) VALUES ('fire-wake', ${orgId}, ${lead}, 'test', 0, 'running', json_array(${eventId}))`;
    yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'fire-wake' WHERE event_id = ${eventId}`;
    const turn = { orgId, agentId: lead, wakeupId: KinWakeupId.make("fire-wake") };
    assert.equal(yield* turnAudience(turn), "shared");
    assert.deepInclude(Option.getOrThrow(yield* laneFor(turn)), {
      chatId: KinChatId.make("group-a"),
    });
    yield* sql`UPDATE kin_events SET state = 'queued', wakeup_id = NULL WHERE event_id = ${eventId}`;
    yield* sql`DELETE FROM kin_wakeups WHERE wakeup_id = 'fire-wake'`;
    yield* leadWakeup({ orgId, eventId, chatId: "group-a", body: "Time to send the report." });
    yield* (yield* LeadDelivery.KinLeadDelivery).settle(orgId);
    const fired = yield* reminderCard("def-s", dueAt);
    assert.equal(fired.chatId, "group-a");
    assert.deepInclude(fired.state, { askedBy: { personId: "teammate", name: "Teammate" } });

    // Someone joined who couldn't read where it was set: the group gets only that it is due, and
    // the teammate the reminder, in her own chat. No turn reads its words for the group.
    yield* join("group-a", "group-latecomer", person("latecomer"));
    yield* tick(dueAt + 30 * 60_000);
    assert.lengthOf(yield* handedReminders(), 1);
    const told = yield* sql<{ chatId: string; body: string }>`SELECT chat_id AS "chatId", body
      FROM kin_messages WHERE org_id = ${orgId} AND (body LIKE 'A reminder %'
        OR body LIKE 'Reminder: def-w.%') ORDER BY chat_id, seq`;
    assert.lengthOf(told, 2);
    assert.match(told[0]!.body, /^A reminder Teammate set on .* is due\.$/);
    assert.deepInclude(told[0], { chatId: "group-a" });
    assert.deepInclude(told[1], { chatId: "teammate-direct" });
    assert.include(told[1]!.body, "Plans got only that it is due");
    yield* sql`UPDATE kin_chat_members SET left_at = '1970-01-02T00:00:00.000Z'
      WHERE org_id = ${orgId} AND member_id = 'group-latecomer'`;

    // Its agent left the group: Kin tells whoever asked, in their own chat, where it was for.
    yield* sql`UPDATE kin_chat_members SET left_at = '1970-01-02T00:00:00.000Z'
      WHERE org_id = ${orgId} AND member_id = 'group-lead'`;
    yield* tick(dueAt + 60 * 60_000);
    assert.lengthOf(yield* handedReminders(), 1);
    const [moved] = yield* sql<{ chatId: string; body: string }>`SELECT chat_id AS "chatId", body
      FROM kin_messages WHERE org_id = ${orgId} AND body LIKE 'Reminder: def-m.%' ORDER BY seq`;
    assert.equal(moved?.chatId, "teammate-direct");
    assert.include(moved?.body ?? "", "It was for Plans, which");
    // Bystander has no chat with the agent: the owner gets one bare line, never its words.
    yield* tick(dueAt + 2 * 60 * 60_000);
    const unreachedLines = yield* sql<{ chatId: string; body: string }>`SELECT chat_id AS "chatId",
        body FROM kin_messages WHERE org_id = ${orgId}
        AND (body LIKE '%def-u%' OR body LIKE 'A reminder Bystander%') ORDER BY seq`;
    assert.lengthOf(unreachedLines, 1);
    assert.deepInclude(unreachedLines[0], { chatId: `chat-${orgId}` });
    assert.match(
      unreachedLines[0]!.body,
      /^A reminder Bystander set on .* for Plans is due, but it couldn't reach them or that chat\.$/,
    );
  }).pipe(Effect.provide(layerFor([here, gone, partners, theirs, late, unreached])));
});

it.effect("a teammate's own reminder comes to them in their chat, never the owner's", () => {
  const remind = makeDeferral("def-t", {
    on_due: "remind",
    chat: KinChatId.make("teammate-direct"),
  });
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* Repository.KinChatRepository;
    const lead = KinAgentId.make(`lead-${orgId}`);
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
        time_zone)
      VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', '1970-01-01T00:00:00.000Z',
        'America/New_York')`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at, direct_key)
      VALUES ('teammate-direct', ${orgId}, 'direct', 0, '1970-01-01T00:00:00.000Z',
        ${`teammate:${lead}`})`;
    for (const [memberId, principal] of [
      ["teammate-in-direct", { _tag: "person", personId: KinPersonId.make("teammate") }],
      ["lead-in-direct", { _tag: "agent", agentId: lead }],
    ] as const)
      yield* repo.addMember({
        orgId,
        chatId: KinChatId.make("teammate-direct"),
        memberId: KinMemberId.make(memberId),
        principal,
        role: "member",
        joinedAt: "1970-01-01T00:00:00.000Z",
        leftAt: null,
        mutedUntil: null,
      });
    yield* (yield* TriggerService.KinTriggerService).syncItem(remind);
    yield* tick(dueAt);

    const card = yield* reminderCard("def-t", dueAt);
    assert.equal(card.chatId, "teammate-direct");
    assert.notProperty(card.state, "fallback");
    const lines = yield* sql<{ chatId: string; body: string }>`SELECT chat_id AS "chatId", body
      FROM kin_messages WHERE org_id = ${orgId} AND body LIKE 'Reminder:%' ORDER BY seq`;
    assert.deepStrictEqual(lines, [{ chatId: "teammate-direct", body: "Reminder: def-t." }]);
    const woken = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
      AND json_extract(json, '$.subject.type') = 'reminder'`;
    assert.lengthOf(woken, 0);
    // Theirs to snooze, to 9:00 tomorrow on their own clock.
    yield* (yield* Chat.KinChatService).act(
      { _tag: "person", orgId, personId: KinPersonId.make("teammate") },
      {
        widgetId: card.widgetId,
        revision: card.revision,
        actionId: "snooze_tomorrow",
        value: "def-t",
        clientActionId: "snooze-def-t",
      },
    );
    assert.deepInclude((yield* reminderCard("def-t", dueAt)).state, {
      status: "snoozed",
      snoozedUntil: "2026-11-13T14:00:00.000Z",
    });
  }).pipe(Effect.provide(layerFor([remind])));
});

it.effect("a reminder whose wake-up fails falls back to Kin's line, marked as a fallback", () => {
  const remind = makeDeferral("def-r", { on_due: "remind" });
  return Effect.gen(function* () {
    yield* setup();
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* TriggerService.KinTriggerService).syncItem(remind);
    yield* tick(dueAt);
    yield* leadWakeup({
      orgId,
      eventId: yield* reminderEvent(),
      chatId: "chat-a",
      status: "failed",
    });
    yield* (yield* LeadDelivery.KinLeadDelivery).settle(orgId);

    const card = yield* reminderCard("def-r", dueAt);
    assert.deepInclude(card.state, { status: "due", fallback: true });
    const [line] = yield* sql<{ body: string; kind: string }>`SELECT body, kind FROM kin_messages
      WHERE org_id = ${orgId} AND message_id = ${card.messageId} ORDER BY seq`;
    assert.equal(line?.kind, "system");
    assert.include(line?.body ?? "", "Reminder: def-r.");
    assert.include(line?.body ?? "", "couldn't write this one, so Kin sent it.");
  }).pipe(Effect.provide(layerFor([remind])));
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
          query: (org, q, view) => spy("query", memory.query(org, q, view)),
          readItem: (org, id, view) => spy("readItem", memory.readItem(org, id, view)),
          readItemQuietly: (org, id, view) =>
            spy("readItemQuietly", memory.readItemQuietly(org, id, view)),
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

      // An L0 lead's deferral lives only on its shadow branch, and still arms and reminds.
      yield* sql`UPDATE kin_leads SET level = 'L0' WHERE org_id = ${orgId}`;
      const remindAt = Date.parse("2026-11-14T03:30:00.000Z");
      repository.files.set(
        "deferrals/def-s.md",
        fixtureItem({
          id: "def-s",
          title: "Invented stretch",
          due: "2026-11-14T09:00+05:30",
          on_due: "remind",
          chat: "chat-a",
          links: [],
        }),
      );
      yield* memory.anchor(orgId, "kin/shadow/lead-a", repository.commit());
      assert.isFalse(
        (yield* memory.query(orgId, { kind: "deferral" })).some((item) => item.id === "def-s"),
      );
      assert.equal((yield* runOf("def-s"))?.state, "armed");
      const [due] = yield* sql<{ nextRunAt: number }>`SELECT next_run_at AS "nextRunAt"
        FROM kin_triggers WHERE org_id = ${orgId} AND trigger_id = 'deferral:def-s:due'`;
      assert.equal(due?.nextRunAt, remindAt);
      yield* tick(remindAt);
      assert.equal((yield* runOf("def-s"))?.state, "reminded");
      assert.deepStrictEqual(
        (yield* handedReminders()).map((row) => row.itemId),
        ["def-s"],
      );
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
    yield* sql`CREATE TEMP TRIGGER fail_remind BEFORE INSERT ON kin_lead_deliveries
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
    Effect.provide(Layer.merge(layerFor([remind]), logger)),
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
