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
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { followOwnerZone, onHostClock } from "./checkInSeeds.ts";
import * as KinPulse from "./KinPulse.ts";
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

const checkIn = (dueAt: number, outside: OutsideRead = nothingOutside) =>
  queueCheckIn({
    orgId,
    agentId: chief,
    scheduleId: afternoon,
    title: "Afternoon check-in",
    what: "Afternoon check-in.",
    dueAt,
    loose: true,
    zone: "UTC",
    at: dueAt,
    outside,
  });

const pulseEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ agent: string; key: string; notBefore: number | null; json: string }>`
    SELECT agent_id AS agent, dedupe_key AS key, not_before AS "notBefore", json
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse' ORDER BY queued_at, event_id`;
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
      // Every day lands inside 15:25 to 15:50.
      for (let day = 0; day < 60; day++) {
        const each = looseOffsetMs(afternoon, `day-${day}`);
        assert.isTrue(each >= 0 && each <= 25 * MINUTE && each % MINUTE === 0);
      }
      // A late task is a judgement call: the main model.
      assert.isTrue(JSON.parse(events[0]!.json).strong);
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
      assert.isTrue(parsed.strong);
      // Run 4: a brief with nothing matched or late still ran on the small model.
      yield* checkIn(SLOT + DAY, {
        lines: [mail("t3:a", "Shop <news@shop.example>", "Sale")],
        seen: [],
      });
      assert.isTrue((yield* pulseEvents).every((one) => JSON.parse(one.json).strong === true));
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
        assert.isTrue(events.every((event) => JSON.parse(event.json).strong === true));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "one nudge per person per working day, only in their hours, none while unanswered",
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
        const posted: Array<string> = [];
        const send = (at: number, factKey: string, person = "Meera") =>
          nudge({
            orgId,
            agentId: chief,
            at,
            person,
            factKey,
            text: "W-8 was due Saturday; the launch waits on it. Still on for today?",
            chatFor: () => Effect.succeed(KinChatId.make("chat-mate")),
            post: (_chatId, clientMessageId) =>
              Effect.sync(() => {
                posted.push(clientMessageId);
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
        // Before their hours: the refusal names when they start and how to ask them then (H16).
        const early = yield* send(MONDAY + 7 * HOUR, factKey);
        assert.match(early, /outside their working hours and starts at 2026-11-16T\d\d:\d\d/);
        assert.include(early, "kin_defer");
        assert.include(yield* send(MONDAY + 10 * HOUR, "task_late:nope"), "can't see that fact");
        // Found as clients are: any case, a start of the name, a close spelling, the handle.
        for (const typed of ["meera", "Mee", "Meeru", "@mate"])
          assert.include(yield* send(MONDAY + 10 * HOUR, "task_late:nope", typed), "can't see");
        assert.include(
          yield* send(MONDAY + 10 * HOUR, factKey, "Meena Rao"),
          "No one called Meena Rao",
        );
        assert.strictEqual(yield* send(MONDAY + 10 * HOUR, factKey), "sent");
        assert.include(yield* send(MONDAY + 15 * HOUR, factKey), "already nudged today");
        assert.include(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "hasn't answered");
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('chat-mate', ${orgId}, 'direct', ${`${mate}:${chief}`}, 0, ${stamp})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
          role, joined_at)
        VALUES ('m-mate', ${orgId}, 'chat-mate', 'person', ${mate}, 'member', ${stamp})`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at)
        VALUES ('reply', ${orgId}, 'chat-mate', 1, 'human', ${mate}, 'm-mate', 'member', 'text',
          'On it', '[]', 'posted', '2026-11-16T12:00:00.000Z')`;
        assert.strictEqual(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "sent");
        assert.deepStrictEqual(posted, [
          "pulse-nudge:mate:2026-11-16",
          "pulse-nudge:mate:2026-11-17",
        ]);
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
            every: onHostClock("09:30", weekdays, "Asia/Kolkata", host, MONDAY),
            existing: true,
            around: true,
          },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );
});
