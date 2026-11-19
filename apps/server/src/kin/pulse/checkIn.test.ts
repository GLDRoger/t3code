import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinMemoryItemId,
  KinOrgId,
  KinPersonId,
  type KinPulseOutsideLine,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { looseOffsetMs, queueCheckIn } from "./checkIn.ts";
import { missedSlot } from "./checkInCatchUp.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { followOwnerZone, onHostClock } from "./checkInSeeds.ts";
import * as KinPulse from "./KinPulse.ts";
import { deliverHeld } from "../triggers/heldDelivery.ts";
import { holdIfQuiet } from "../triggers/quietHold.ts";
import { inHoursAt, nudge } from "./nudge.ts";
import { type OutsideRead, type OutsideSource, poll } from "./outside.ts";

// Invented company, people, mail and calendar only; nothing here reads a real database or service.
const orgId = KinOrgId.make("org");
const owner = KinPersonId.make("owner");
const mate = KinPersonId.make("mate");
const chief = KinAgentId.make("cos");
const finance = KinAgentId.make("fin");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Monday 16 November 2026, 15:25 UTC: the afternoon check-in's window opens.
const MONDAY = Date.UTC(2026, 10, 16);
const SLOT = MONDAY + 15 * HOUR + 25 * MINUTE;
const stamp = "2026-10-01T00:00:00.000Z";
const afternoon = KinMemoryItemId.make("checkin-afternoon");

const layer = KinEventQueue.layer.pipe(
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${stamp})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
      time_zone, work_hours_json)
    VALUES (${owner}, ${orgId}, 'owner', 'Arjun', ${stamp}, NULL, NULL),
      (${mate}, ${orgId}, 'mate', 'Meera', ${stamp}, 'UTC',
        '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}')`;
  for (const [agent, domain] of [
    [chief, "chief-of-staff"],
    [finance, "finance"],
  ] as const) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agent}, ${orgId}, ${agent}, 'lead', ${owner}, ${stamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${`chat-${agent}`}, ${orgId}, 'team_group', 0, ${stamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agent}, ${orgId}, ${agent}, 0, '{}', '[]', ${`chat-${agent}`}, ${domain})`;
  }
  for (const [id, prefix] of [
    ["work", "W"],
    ["clients", "C"],
    ["contacts", "CT"],
    ["invoices", "INV"],
  ] as const)
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${id}, ${id}, ${prefix}, 1, 0)`;
});

const record = Effect.fn("test.record")(function* (row: {
  readonly key: string;
  readonly list: string;
  readonly title: string;
  readonly state?: string;
  readonly ownerId?: string;
  readonly ownerKind?: string;
  readonly dueAt?: number;
  readonly partyId?: string;
  readonly fields?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, party_id, due_at, fields_json, created_by_kind, created_by_id, origin_key,
      created_at, updated_at)
    VALUES (${orgId}, ${`r-${row.key}`}, ${row.list}, ${row.key}, ${row.title},
      ${row.state ?? "open"}, ${row.ownerKind ?? "agent"}, ${row.ownerId ?? chief},
      ${row.partyId ?? null}, ${row.dueAt ?? null}, ${row.fields ?? "{}"}, 'person', ${owner},
      ${`origin-${row.key}`}, ${MONDAY - 30 * DAY}, ${MONDAY - 30 * DAY})`;
});

const mail = (id: string, who: string, subject: string): KinPulseOutsideLine => ({
  source: "mail",
  connection: "Google",
  id,
  at: "Mon, 16 Nov 2026 10:41:00 +0000",
  who,
  subject,
  where: null,
});
const source = (lines: ReadonlyArray<KinPulseOutsideLine>): OutsideSource => ({
  read: () => Effect.succeed({ lines, seen: [] }),
  seen: () => Effect.void,
});
const nothingOutside: OutsideRead = { lines: [], seen: [] };

const checkIn = (dueAt: number, outside: OutsideRead = nothingOutside, at = dueAt) =>
  queueCheckIn({
    orgId,
    agentId: chief,
    scheduleId: afternoon,
    title: "Afternoon check-in",
    what: "Afternoon check-in.",
    dueAt,
    looseAt: "15:30",
    zone: "UTC",
    at,
    outside,
  });

const pulseEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ agent: string; key: string; notBefore: number | null; json: string }>`
    SELECT agent_id AS agent, dedupe_key AS key, not_before AS "notBefore", json
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse' ORDER BY queued_at, event_id`;
});

/** A seeded check-in's row and native task, as `KinSchedules.save` writes them. */
const scheduleRow = Effect.fn("test.scheduleRow")(function* (row: {
  readonly slug: string;
  readonly at: string;
  readonly days: ReadonlyArray<number>;
  readonly source?: string;
  readonly looseAt?: string | null;
  readonly enabled?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const taskId = KinSchedules.scheduleTaskId(orgId, `checkin-${row.slug}`);
  yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
      project_id, workspace_strategy_json, model_selection_json, runtime_mode,
      interaction_mode, created_by, creation_source, created_at, updated_at,
      last_run_status, run_count)
    VALUES (${taskId}, ${row.slug}, 'Check in', ${row.enabled === false ? 0 : 1}, ${JSON.stringify({
      type: "fixed_time",
      timeOfDay: row.at,
      weekdays: row.days,
    })}, 'project', '{}', '{}', 'approval-required', 'plan', 'system', 'server', ${stamp},
      ${stamp}, 'never', 0)`;
  yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
      source_event, said_by, audience, content_sha256, inbox_thread_id, created_at,
      updated_at, loose_at, check_in)
    VALUES (${taskId}, ${orgId}, ${`checkin-${row.slug}`}, ${chief}, ${`chat-${chief}`},
      ${row.source ?? `kin-seed:check-ins:${orgId}`}, ${owner}, 'owner_only', 'hash', 'inbox', 0, 0,
      ${row.looseAt ?? null}, 1)`;
});

describe("pulse check-ins", () => {
  it.effect("a loose slot queues once at its own minute, and another day at another", () =>
    Effect.gen(function* () {
      yield* seed;
      // Nothing open and nothing new: no event, so no model starts.
      assert.deepStrictEqual(yield* checkIn(SLOT), { _tag: "nothing_new" });
      assert.lengthOf(yield* pulseEvents, 0);

      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      const first = yield* checkIn(SLOT);
      // The same slot fired again, as after a restart: the stored event and its minute stand.
      const again = yield* checkIn(SLOT);
      const offset = looseOffsetMs(afternoon, "2026-11-16");
      assert.strictEqual(first._tag, "queued");
      assert.strictEqual(again._tag, "duplicate");
      assert.strictEqual(first._tag === "queued" ? first.notBefore : 0, SLOT + offset);
      // W-1 was told Monday; Tuesday's check-in runs for a task late since.
      yield* record({ key: "W-2", list: "work", title: "Invented flyer", dueAt: MONDAY + HOUR });
      const tuesday = yield* checkIn(SLOT + DAY);
      const events = yield* pulseEvents;
      assert.deepStrictEqual(
        events.map((event) => [event.key, event.notBefore]),
        [
          ["checkin:checkin-afternoon:2026-11-16", SLOT + offset],
          [
            "checkin:checkin-afternoon:2026-11-17",
            SLOT + DAY + looseOffsetMs(afternoon, "2026-11-17"),
          ],
        ],
      );
      assert.strictEqual(tuesday._tag, "queued");
      assert.notStrictEqual(looseOffsetMs(afternoon, "2026-11-17"), offset);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a late start picks its minute inside the window; a catch-up after it fires at once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* record({
          key: "W-1",
          list: "work",
          title: "Invented site copy",
          dueAt: MONDAY - DAY,
        });
        const ends: Array<number> = [];
        for (let day = 0; day < 7; day++) {
          const opens = SLOT + day * DAY;
          // Something untold each day, so each day's check-in runs.
          yield* record({
            key: `W-${day + 10}`,
            list: "work",
            title: "Invented poster",
            dueAt: opens - HOUR,
          });
          // The host woke ten minutes into the window, inside T3's grace: the run starts late.
          const late = yield* checkIn(opens + 10 * MINUTE);
          if (late._tag !== "queued") return assert.fail("not queued");
          assert.isAtLeast(late.notBefore, opens + 10 * MINUTE);
          ends.push(late.notBefore - opens);
        }
        assert.isTrue(ends.every((minute) => minute <= 25 * MINUTE));
        yield* record({ key: "W-20", list: "work", title: "Invented card", dueAt: SLOT + 6 * DAY });
        // 17:25 on the owner's UTC clock: before his quiet hours, so nothing holds it.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30',
          '03:00', 0, 1, '09:00', '{"from":"22:00","to":"08:00"}')`;
        // Noticed two hours late, after the window closed: at once, not a further offset.
        const caught = yield* checkIn(SLOT + 7 * DAY, nothingOutside, SLOT + 7 * DAY + 2 * HOUR);
        assert.strictEqual(
          caught._tag === "queued" ? caught.notBefore : 0,
          SLOT + 7 * DAY + 2 * HOUR,
        );
      }).pipe(Effect.provide(layer)),
  );

  // Monday 15:25 UTC opens the window; T3 has moved on to Tuesday unless a row says otherwise.
  it.each([
    { name: "twelve minutes in", now: SLOT + 12 * MINUTE, fires: true },
    { name: "past three hours", now: SLOT + 3 * HOUR, fires: false },
    { name: "before it opens", now: SLOT - MINUTE, fires: false },
    { name: "already ran today", now: SLOT + HOUR, lastRunAt: SLOT + MINUTE, fires: false },
    { name: "T3 still has it due", now: SLOT + 5 * MINUTE, nextRunAt: SLOT, fires: false },
    { name: "not a day it runs", now: SLOT + HOUR, weekdays: [2, 3], fires: false },
  ])("a slept-through check-in catches up only that day, once ($name)", (row) => {
    const opens = missedSlot(
      {
        timeOfDay: "15:25",
        weekdays: row.weekdays ?? [1, 2, 3, 4, 5],
        nextRunAt: row.nextRunAt ?? SLOT + DAY,
        lastRunAt: row.lastRunAt ?? SLOT - DAY,
      },
      row.now,
      "UTC",
    );
    assert.strictEqual(opens, row.fires ? SLOT : undefined);
  });

  it.effect("a fact someone has in hand still brings the check-in, never 'nothing new'", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* record({
        key: "W-2",
        list: "work",
        title: "Invented brochure",
        ownerKind: "person",
        ownerId: mate,
        dueAt: MONDAY - DAY,
      });
      const [fact] = (yield* KinPulse.read({ orgId, at: SLOT, viewer: { _tag: "owner" } })).facts;
      if (fact === undefined) return assert.fail("no fact");
      yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id, scope_json,
          first_seen_at, last_seen_at, handled_by_kind, handled_by_id, handled_at, handled_until)
        VALUES (${orgId}, ${fact.key}, ${fact.sense}, ${fact.subject.recordId ?? null}, '{}',
          ${SLOT - HOUR}, ${SLOT - HOUR}, 'agent', ${chief}, ${SLOT - HOUR}, ${SLOT + 2 * DAY})`;
      const held = yield* checkIn(SLOT);
      assert.strictEqual(held._tag, "queued");
      assert.strictEqual(held._tag === "queued" ? held.facts : 0, 1);
      // Marked not a problem, it has no end: on its own it starts no check-in.
      yield* sql`UPDATE kin_pulse_facts SET handled_until = NULL WHERE fact_key = ${fact.key}`;
      assert.deepStrictEqual(yield* checkIn(SLOT + DAY), { _tag: "nothing_new" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a fact is told once; only a change, a failed turn or Run now tells it again", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const told = (key: string) =>
        sql<{ key: string }>`SELECT DISTINCT t.fact_key AS key FROM kin_pulse_told t
          JOIN kin_events e ON e.event_id = t.event_id WHERE e.dedupe_key = ${key}
          ORDER BY t.fact_key`.pipe(Effect.map((rows) => rows.map((row) => row.key)));
      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      assert.strictEqual((yield* checkIn(SLOT))._tag, "queued");
      const [w1] = yield* told("checkin:checkin-afternoon:2026-11-16");
      assert.match(w1 ?? "", /W-1/);
      // The next day W-1 is still open and unchanged: no turn, so no "still" message.
      assert.deepStrictEqual(yield* checkIn(SLOT + DAY), { _tag: "nothing_new" });
      // The first slot fired again after a restart is still that slot's own event.
      assert.strictEqual((yield* checkIn(SLOT))._tag, "duplicate");
      // Run now is someone asking: it runs, with everything open.
      const asked = yield* queueCheckIn({
        orgId,
        agentId: chief,
        scheduleId: afternoon,
        title: "Afternoon check-in",
        what: "Afternoon check-in.",
        dueAt: SLOT + DAY,
        looseAt: null,
        manualId: "run-now-1",
        zone: "UTC",
        at: SLOT + DAY,
        outside: nothingOutside,
      });
      assert.strictEqual(asked._tag, "queued");
      assert.deepStrictEqual(yield* told("checkin:checkin-afternoon:run-now-1"), [w1]);
      // Changed: Finance takes W-1 in hand until Friday, and W-3 is new: both are told.
      yield* record({ key: "W-3", list: "work", title: "Invented menu", dueAt: MONDAY });
      yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id, scope_json,
          first_seen_at, last_seen_at, handled_by_kind, handled_by_id, handled_at, handled_until)
        VALUES (${orgId}, ${w1!}, 'task_late', 'r-W-1', '{}', ${SLOT}, ${SLOT}, 'agent', ${finance},
          ${SLOT + DAY}, ${SLOT + 4 * DAY})`;
      assert.strictEqual((yield* checkIn(SLOT + 2 * DAY))._tag, "queued");
      const wednesday = yield* told("checkin:checkin-afternoon:2026-11-18");
      assert.lengthOf(wednesday, 2);
      // A check-in whose turn failed told nothing: the next one tells it again.
      yield* sql`UPDATE kin_events SET state = 'failed'
        WHERE dedupe_key = 'checkin:checkin-afternoon:2026-11-18'`;
      assert.strictEqual((yield* checkIn(SLOT + 3 * DAY))._tag, "queued");
      assert.deepStrictEqual(yield* told("checkin:checkin-afternoon:2026-11-19"), wednesday);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("on the weekly brief's day one page: the first brief carries the figures", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      yield* scheduleRow({ slug: "weekly", at: "09:00", days: [1] });
      const run = (scheduleId: string, at: number) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make(scheduleId),
          title: scheduleId,
          what: "Check-in.",
          dueAt: at,
          looseAt: null,
          zone: "UTC",
          at,
          outside: nothingOutside,
        });
      const figures = Effect.map(pulseEvents, (events) =>
        events
          .map((event) => [event.key, JSON.parse(event.json).checkIn.figures ?? false])
          .toSorted(([a], [b]) => String(a.slice(-10)).localeCompare(b.slice(-10))),
      );
      // The weekly brief first: it carries the figures, and the morning brief is folded into it.
      assert.strictEqual((yield* run("checkin-weekly", MONDAY + 9 * HOUR))._tag, "queued");
      yield* record({ key: "W-2", list: "work", title: "Invented flyer", dueAt: MONDAY + HOUR });
      assert.deepStrictEqual(yield* run("checkin-morning", MONDAY + 9 * HOUR + 30 * MINUTE), {
        _tag: "folded",
        into: "checkin-weekly",
      });
      // Tuesday has no weekly brief: the morning brief runs, with no figures.
      assert.strictEqual((yield* run("checkin-morning", MONDAY + DAY + 9 * HOUR))._tag, "queued");
      // The next Monday the morning brief comes first: it carries them, and the weekly is folded.
      const next = MONDAY + 7 * DAY;
      assert.strictEqual((yield* run("checkin-morning", next + 8 * HOUR))._tag, "queued");
      assert.deepStrictEqual(yield* run("checkin-weekly", next + 9 * HOUR), {
        _tag: "folded",
        into: "checkin-morning",
      });
      // The weekly brief switched off: that Monday's morning brief is a morning like any other.
      yield* sql`UPDATE kin_schedules SET pending_enabled = 0 WHERE schedule_id = 'checkin-weekly'`;
      assert.strictEqual((yield* run("checkin-morning", next + 7 * DAY + 8 * HOUR))._tag, "queued");
      // With the morning brief off on Mondays, the weekly comes by its own setting, with them.
      yield* sql`UPDATE kin_schedules SET pending_enabled = NULL WHERE schedule_id = 'checkin-weekly'`;
      assert.strictEqual((yield* run("checkin-weekly", next + 14 * DAY + 9 * HOUR))._tag, "queued");
      assert.deepStrictEqual(yield* figures, [
        ["checkin:checkin-weekly:2026-11-16", true],
        ["checkin:checkin-morning:2026-11-17", false],
        ["checkin:checkin-morning:2026-11-23", true],
        ["checkin:checkin-morning:2026-11-30", false],
        ["checkin:checkin-weekly:2026-12-07", true],
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a quiet day still brings the briefs; a quiet afternoon check-in stays silent", () =>
    Effect.gen(function* () {
      yield* seed;
      const run = (scheduleId: string, at: number) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make(scheduleId),
          title: scheduleId,
          what: "Check-in.",
          dueAt: at,
          looseAt: null,
          zone: "UTC",
          at,
          outside: nothingOutside,
        });
      // Nothing open anywhere and nothing new outside.
      const TUESDAY = MONDAY + DAY;
      assert.deepStrictEqual(yield* run("checkin-afternoon", TUESDAY + 15 * HOUR), {
        _tag: "nothing_new",
      });
      for (const [scheduleId, at] of [
        ["checkin-morning", TUESDAY + 9 * HOUR],
        ["checkin-evening", TUESDAY + 18 * HOUR],
        ["checkin-weekly", MONDAY + 7 * DAY + 9 * HOUR],
      ] as const)
        assert.include(yield* run(scheduleId, at), { _tag: "queued", facts: 0, outside: 0 });
      assert.deepStrictEqual((yield* pulseEvents).map((event) => event.key).toSorted(), [
        "checkin:checkin-evening:2026-11-17",
        "checkin:checkin-morning:2026-11-17",
        "checkin:checkin-weekly:2026-11-23",
      ]);
      // An evening summary that its owner's quiet hours would hold past midnight isn't queued:
      // the morning brief covers its day.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30',
        '03:00', 0, 1, '09:00', '{"from":"22:00","to":"08:00"}')`;
      assert.deepStrictEqual(yield* run("checkin-evening", TUESDAY + DAY + 22 * HOUR), {
        _tag: "past_its_day",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a check-in in the owner's quiet hours waits for 08:00; Run now never does", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30',
        '03:00', 0, 1, '09:00', '{"from":"22:00","to":"08:00"}')`;
      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      const night = MONDAY + 23 * HOUR + 30 * MINUTE;
      const at = (scheduleId: string, manualId?: string) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make(scheduleId),
          title: scheduleId,
          what: "Check-in.",
          dueAt: night,
          looseAt: null,
          manualId,
          zone: "UTC",
          at: night,
          outside: nothingOutside,
        });
      const held = yield* at("checkin-late");
      assert.strictEqual(held._tag === "queued" ? held.notBefore : 0, MONDAY + DAY + 8 * HOUR);
      // Stored on the event: fired again after a restart, the same hold stands.
      const again = yield* at("checkin-late");
      assert.strictEqual(again._tag === "duplicate" ? again.notBefore : 0, MONDAY + DAY + 8 * HOUR);
      const asked = yield* at("checkin-late", "run-now-2");
      assert.strictEqual(asked._tag === "queued" ? asked.notBefore : 0, night);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("server lines in someone's quiet hours post once at 08:00, merged per chat", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30',
        '03:00', 0, 1, '09:00', '{"from":"22:00","to":"08:00"}')`;
      const posted: Array<{ messageId: string; body: string }> = [];
      const chat = {
        notice: (input: { readonly messageId: string; readonly body: string }) =>
          Effect.sync(() => {
            if (!posted.some((one) => one.messageId === input.messageId)) posted.push(input);
          }).pipe(Effect.as({} as never)),
      };
      const line = (body: string) =>
        holdIfQuiet({
          orgId,
          chatId: KinChatId.make("chat-cos"),
          personId: owner,
          kind: "memory",
          body,
          audience: "owner",
        });
      yield* TestClock.setTime(MONDAY + 15 * HOUR);
      assert.isFalse(yield* line("Invented daytime line."));
      yield* TestClock.setTime(MONDAY + 23 * HOUR);
      assert.isTrue(yield* line("Invented first night line."));
      yield* TestClock.setTime(MONDAY + DAY + 3 * HOUR);
      assert.isTrue(yield* line("Invented second night line."));
      assert.strictEqual(yield* deliverHeld(orgId, chat), 0);
      yield* TestClock.setTime(MONDAY + DAY + 8 * HOUR);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 1);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 0);
      assert.deepStrictEqual(
        posted.map((one) => one.body),
        ["Invented first night line.\n\nInvented second night line."],
      );
      // Kin asleep all day wakes in the next night: the line waits for that night's end.
      yield* TestClock.setTime(MONDAY + DAY + 23 * HOUR);
      assert.isTrue(yield* line("Invented third night line."));
      yield* TestClock.setTime(MONDAY + 2 * DAY + 23 * HOUR);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 0);
      yield* TestClock.setTime(MONDAY + 3 * DAY + 8 * HOUR);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 1);
      assert.lengthOf(posted, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a check-in carries new outside lines, matched ones first, as metadata", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* record({ key: "C-1", list: "clients", title: "Lumen" });
      yield* record({
        key: "CT-1",
        list: "contacts",
        title: "Priya",
        partyId: "r-C-1",
        fields: '{"email":"priya@lumen.example"}',
      });
      const result = yield* checkIn(SLOT, {
        lines: [
          mail("t1:a", "Shop <news@shop.example>", "Weekend sale"),
          mail("t2:a", "Priya <Priya@lumen.example>", "Re: launch date"),
        ],
        seen: [],
      });
      assert.strictEqual(result._tag, "queued");
      const [event] = yield* pulseEvents;
      const parsed = JSON.parse(event!.json);
      assert.deepStrictEqual(
        parsed.outside.map((line: KinPulseOutsideLine) => [line.id, line.matched ?? null]),
        [
          ["t2:a", "contact CT-1 Priya of client C-1 Lumen"],
          ["t1:a", null],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "between check-ins, only mail a watch matches or a new person wakes an agent, once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* record({ key: "C-1", list: "clients", title: "Lumen" });
        yield* record({
          key: "CT-1",
          list: "contacts",
          title: "Priya",
          partyId: "r-C-1",
          fields: '{"email":"priya@lumen.example"}',
        });
        yield* record({ key: "INV-4", list: "invoices", title: "October", state: "waiting" });
        const lines = [
          mail("t1:a", "Shop <news@shop.example>", "Weekend sale"),
          mail("t2:a", "Priya <priya@lumen.example>", "Re: launch date"),
          mail("t3:a", "accounts@lumen.example", "Re: INV-4 for October"),
          // INV-40 is not INV-4.
          mail("t4:a", "accounts@other.example", "INV-40 attached"),
        ];
        // Sent to one of the company's addresses: a person Kin doesn't know is maybe a new client
        // (H07); a list, a no-reply sender or the company's own people are not.
        const toUs = (line: KinPulseOutsideLine) => ({ ...line, to: "hello@studio.example" });
        const unknown = [
          toUs(
            mail("t5:a", "Meera Iyer <meera@lumengrove.example>", "Booking app for our clinics"),
          ),
          toUs(mail("t6:a", "Shop <news@shop.example>", "Weekend sale")),
          toUs(mail("t7:a", "Bank <no-reply@bank.example>", "Your statement")),
          toUs(mail("t8:a", "Offers <deals@em.shop.example>", "Just for you")),
          toUs(mail("t9:a", "Dev <dev@studio.example>", "Lunch?")),
        ];
        assert.lengthOf(
          yield* poll(orgId, SLOT, source([lines[0]!, lines[3]!, ...unknown.slice(1)])),
          0,
        );
        assert.lengthOf(yield* pulseEvents, 0);
        assert.sameMembers(yield* poll(orgId, SLOT, source([...lines, ...unknown])), [
          "t2:a",
          "t3:a",
          "t5:a",
        ]);
        assert.lengthOf(yield* poll(orgId, SLOT + 3 * MINUTE, source(lines)), 0);
        const events = yield* pulseEvents;
        assert.sameMembers(
          events.map((event) => event.agent),
          [chief, finance, chief],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "one nudge per person per working day, held until their hours, none while unanswered",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* record({
          key: "W-8",
          list: "work",
          title: "Invented banner",
          ownerKind: "person",
          ownerId: mate,
          dueAt: MONDAY - 2 * DAY,
        });
        const posted: Array<readonly [string, number | undefined]> = [];
        const send = (at: number, factKey: string, person = "Meera") =>
          nudge({
            orgId,
            agentId: chief,
            at,
            person,
            factKey,
            text: "W-8 was due Saturday; the launch waits on it. Still on for today?",
            chatFor: () => Effect.succeed(KinChatId.make("chat-mate")),
            post: (_chatId, clientMessageId, _personId, notBefore) =>
              Effect.sync(() => {
                posted.push([clientMessageId, notBefore]);
                return undefined;
              }),
          }).pipe(
            Effect.as("sent"),
            Effect.catchTags({ KinChatError: (error) => Effect.succeed(error.message) }),
          );
        const { facts } = yield* KinPulse.read({
          orgId,
          at: MONDAY + 10 * HOUR,
          viewer: { _tag: "people", people: [mate] },
        });
        const factKey = facts.find((fact) => fact.subject.key === "W-8")!.key;
        // Before their hours it is taken and held until they start, as that day's nudge.
        assert.strictEqual(yield* send(MONDAY + 7 * HOUR, factKey), "sent");
        assert.isAbove(posted[0]![1]!, MONDAY + 7 * HOUR);
        assert.include(yield* send(MONDAY + 10 * HOUR, "task_late:nope"), "can't see that fact");
        // Found as clients are: any case, a start of the name, a close spelling, the handle.
        for (const typed of ["meera", "Mee", "Meeru", "@mate"])
          assert.include(yield* send(MONDAY + 10 * HOUR, "task_late:nope", typed), "can't see");
        assert.include(
          yield* send(MONDAY + 10 * HOUR, factKey, "Meena Rao"),
          "No one called Meena Rao",
        );
        assert.include(yield* send(MONDAY + 10 * HOUR, factKey), "already nudged today");
        assert.include(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "hasn't answered");
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('chat-mate', ${orgId}, 'direct', ${`${mate}:${chief}`}, 0, ${stamp})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
          role, joined_at)
        VALUES ('m-mate', ${orgId}, 'chat-mate', 'person', ${mate}, 'member', ${stamp})`;
        // A request of theirs Kin passed on into this chat is no answer to the nudge.
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at, origin_json)
        VALUES ('copy', ${orgId}, 'chat-mate', 1, 'human', ${mate}, 'm-mate', 'member', 'text',
          'Can Finance send it?', '[]', 'posted', '2026-11-16T11:00:00.000Z',
          '{"messageId":"asked","chatId":"chat-elsewhere"}')`;
        assert.include(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "hasn't answered");
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at)
        VALUES ('reply', ${orgId}, 'chat-mate', 2, 'human', ${mate}, 'm-mate', 'member', 'text',
          'On it', '[]', 'posted', '2026-11-16T12:00:00.000Z')`;
        assert.strictEqual(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "sent");
        assert.deepStrictEqual(posted.slice(1), [["pulse-nudge:mate:2026-11-17", undefined]]);
        assert.strictEqual(posted[0]![0], "pulse-nudge:mate:2026-11-16");
      }).pipe(Effect.provide(layer)),
  );

  it("a person's own hours decide, in their zone or else the owner's, not the quiet hours", () => {
    // 22:30 in Kolkata on a Sunday: inside Dev's 10:00–23:59 every day, though past 21:00.
    const late = Date.UTC(2026, 10, 15, 17, 0);
    const dev = {
      timeZone: null,
      workHours: '{"days":[0,1,2,3,4,5,6],"start":"10:00","end":"23:59"}',
    };
    assert.isTrue(inHoursAt(dev, "Asia/Kolkata", late));
    assert.isFalse(inHoursAt({ timeZone: null, workHours: null }, "Asia/Kolkata", late));
    // A whole-day row stored before it meant "not set" reads as no hours, not as always working.
    const wholeDay = '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}';
    assert.isFalse(inHoursAt({ timeZone: null, workHours: wholeDay }, "Asia/Kolkata", late));
    assert.isFalse(
      inHoursAt({ ...dev, timeZone: "Europe/London" }, "Asia/Kolkata", late - 9 * HOUR),
    );
  });

  it("seeded times move to the host clock, and their days with them across midnight", () => {
    const monday = Date.UTC(2026, 10, 16);
    assert.deepStrictEqual(onHostClock("09:30", [1, 2], "Asia/Kolkata", "UTC", monday), {
      at: "04:00",
      days: [1, 2],
    });
    assert.deepStrictEqual(onHostClock("02:00", [1], "Asia/Kolkata", "UTC", monday), {
      at: "20:30",
      days: [0],
    });
  });
  // G08: check-ins seeded while the zone was unset stayed on that clock after it was set.
  it.effect("default check-ins follow the owner's zone once set; one he moved stays put", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(MONDAY);
      const host = KinSchedules.hostTimeZone();
      const weekdays = [1, 2, 3, 4, 5];
      const seededAt = (zone: string) => onHostClock("09:30", weekdays, zone, host, MONDAY);
      // A loose check-in's native task starts its window five minutes early.
      const fiveBefore = (at: string) => {
        const minutes = Math.max(0, Number(at.slice(0, 2)) * 60 + Number(at.slice(3)) - 5);
        return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      };
      for (const [slug, source, at] of [
        ["morning", `kin-seed:check-ins:${orgId}`, seededAt("Pacific/Honolulu")],
        ["afternoon", "chat-event", seededAt("Pacific/Honolulu")],
      ] as const) {
        const taskId = KinSchedules.scheduleTaskId(orgId, `checkin-${slug}`);
        yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
            project_id, workspace_strategy_json, model_selection_json, runtime_mode,
            interaction_mode, created_by, creation_source, created_at, updated_at,
            last_run_status, run_count)
          VALUES (${taskId}, ${slug}, 'Check in', 1, ${JSON.stringify({
            type: "fixed_time",
            timeOfDay: fiveBefore(at.at),
            weekdays: at.days,
          })}, 'project', '{}', '{}', 'approval-required', 'plan', 'system', 'server', ${stamp},
            ${stamp}, 'never', 0)`;
        yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
            source_event, said_by, audience, content_sha256, inbox_thread_id, created_at,
            updated_at, loose_at, check_in)
          VALUES (${taskId}, ${orgId}, ${`checkin-${slug}`}, ${chief}, ${`chat-${chief}`},
            ${source}, ${owner}, 'owner_only', 'hash', 'inbox', 0, 0, ${at.at}, 1)`;
      }
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief,
          evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check,
          quiet_hours_json)
        VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
      const saved: Array<KinSchedules.SaveInput> = [];
      const schedules = KinSchedules.KinSchedules.of({
        save: (input) => Effect.sync(() => void saved.push(input)),
        cancel: () => Effect.void,
        applyTaps: () => Effect.void,
      });
      yield* followOwnerZone(orgId, schedules);
      assert.deepStrictEqual(
        saved.map(({ scheduleId, every, existing, around }) => ({
          scheduleId,
          every,
          existing,
          around,
        })),
        [
          {
            scheduleId: KinMemoryItemId.make("checkin-morning"),
            // The morning brief's default is every day: one seeded on weekdays gets the weekend too.
            every: onHostClock("09:30", [0, 1, 2, 3, 4, 5, 6], "Asia/Kolkata", host, MONDAY),
            existing: true,
            around: true,
          },
        ],
      );
      assert.isTrue(saved.every((input) => input.keepWording === true));
    }).pipe(Effect.provide(layer)),
  );
  it.effect("a default morning whose days alone were changed keeps them at rollout", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.setTime(MONDAY);
      const host = KinSchedules.hostTimeZone();
      // Seeded on weekdays at 09:30 in the company's zone, then Friday was taken off on T3's screen.
      const at = onHostClock("09:30", [1, 2, 3, 4], "UTC", host, MONDAY);
      const fiveBefore = onHostClock("09:25", [1, 2, 3, 4], "UTC", host, MONDAY);
      yield* scheduleRow({ slug: "morning", at: fiveBefore.at, days: at.days, looseAt: at.at });
      const saved: Array<KinSchedules.SaveInput> = [];
      yield* followOwnerZone(
        orgId,
        KinSchedules.KinSchedules.of({
          save: (input) => Effect.sync(() => void saved.push(input)),
          cancel: () => Effect.void,
          applyTaps: () => Effect.void,
        }),
      );
      assert.deepStrictEqual(saved, []);
    }).pipe(Effect.provide(layer)),
  );
});
