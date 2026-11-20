import { assert, it } from "@effect/vitest";
import { KinOrgId, KinPersonId, KinTriggerId, type KinTriggerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as KinRecords from "../work/KinRecords.ts";
import { dayIn } from "../work/money.ts";
import { endOfDay, ownerZone, unsetOwnerZone } from "../work/recordRows.ts";
import * as OwnerTimeZone from "./ownerTimeZone.ts";
import * as Routines from "./routines.ts";
import * as TriggerStore from "./KinTriggerStore.ts";
import { fixture, seed, orgId as orgA, otherOrg } from "./routines.testkit.ts";

const settings: KinTriggerSettings = {
  orgId: KinOrgId.make("a"),
  timeZone: "Asia/Kolkata",
  morningBrief: "08:30",
  eveningSummary: "18:30",
  dream: "03:00",
  ownerCheck: "09:00",
  ownerCheckWeekday: 1,
  fullRebuildWeekday: 0,
  quietHours: { from: "21:00", to: "08:00" },
};
it.effect("Stop pauses what is left of the routines and expires their queued runs", () =>
  Effect.gen(function* () {
    yield* seed();
    const routines = yield* Routines.KinRoutines;
    const sql = yield* SqlClient.SqlClient;
    assert.isTrue(yield* routines.isEnabled(orgA, "morning_brief"));
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at) VALUES ('routine-a', ${orgA}, 'lead-a', 'routine', 'P2', '{}', 0, 0)`;
    yield* routines.pauseAll(orgA);
    assert.isFalse(yield* routines.isEnabled(orgA, "morning_brief"));
    assert.isTrue(yield* routines.isEnabled(otherOrg, "morning_brief"));
    assert.deepEqual(
      yield* sql`SELECT state FROM kin_events WHERE org_id = ${orgA} ORDER BY event_id`,
      [{ state: "expired" }],
    );
    yield* routines.resumeAll(orgA);
    assert.isTrue(yield* routines.isEnabled(orgA, "morning_brief"));
  }).pipe(Effect.provide(fixture())),
);

it.effect("the owner's time zone reschedules the company's triggers; only he sets it", () =>
  Effect.gen(function* () {
    yield* seed();
    const routines = yield* Routines.KinRoutines;
    const store = yield* TriggerStore.KinTriggerStore;
    const sql = yield* SqlClient.SqlClient;
    // Unset, the host's zone would stand in; the defaults here are read in UTC.
    yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgA}, 'UTC', '08:30', '18:30', '03:00', 0, 1, '09:00',
      '{"from":"21:00","to":"08:00"}')`;
    const zones = yield* OwnerTimeZone.KinOwnerTimeZone;
    yield* zones.attach(routines);
    yield* TestClock.setTime(Date.parse("2026-11-09T00:00:00.000Z"));
    const dream = KinTriggerId.make("routine:dream");
    yield* store.put({
      id: dream,
      orgId: orgA,
      subject: { type: "routine", routine: "dream" },
      schedule: { type: "fixed_time", timeOfDay: "03:00" },
      timeZone: "UTC",
      enabled: true,
      nextRunAt: "2026-11-09T03:00:00.000Z",
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    });
    const owner = [{ _tag: "person", orgId: orgA, personId: KinPersonId.make("owner-a") }] as const;
    const memberId = KinPersonId.make("member-a");
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES (${memberId}, ${orgA}, 'member', 'Member', '2026-11-07T00:00:00.000Z')`;
    const member = [{ _tag: "person", orgId: orgA, personId: memberId }] as const;
    const input = { orgId: orgA, timeZone: "Asia/Kolkata" };

    assert.deepEqual(yield* zones.get(owner, input), { orgId: orgA, timeZone: "UTC" });
    assert.include(yield* zones.set(member, input).pipe(Effect.flip), { reason: "not_allowed" });
    assert.deepEqual(yield* zones.get(member, input), { orgId: orgA, timeZone: "UTC" });
    assert.include(
      yield* zones.set(owner, { ...input, timeZone: "Mars/Olympus" }).pipe(Effect.flip),
      { reason: "invalid_state" },
    );
    assert.equal((yield* store.get(orgA, dream))?.timeZone, "UTC");

    assert.deepEqual(yield* zones.set(owner, input), input);
    assert.deepEqual(yield* zones.get(owner, input), input);
    // 03:00 in Kolkata: today's slot has passed there.
    assert.equal((yield* store.get(orgA, dream))?.nextRunAt, "2026-11-09T21:30:00.000Z");
    const [row] = yield* sql<{
      morning_brief: string;
      quiet_hours_json: string;
    }>`SELECT morning_brief, quiet_hours_json FROM kin_trigger_settings WHERE org_id = ${orgA}`;
    assert.deepEqual(row, {
      morning_brief: "08:30",
      quiet_hours_json: '{"from":"21:00","to":"08:00"}',
    });
  }).pipe(Effect.provide(OwnerTimeZone.layer.pipe(Layer.provideMerge(fixture())))),
);

// Play-test (Nov 2026): the owner's device set the company's zone to its own, and every all-day
// day read one later for everyone.
it.effect(
  "a new company zone keeps each all-day day, the first one after the host's too; a time stays, a failure keeps the old zone, open Work hears",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const routines = yield* Routines.KinRoutines;
      const records = yield* KinRecords.KinRecords;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-20T12:00:00.000Z"));
      const me = { _tag: "person", personId: KinPersonId.make("owner-a") } as const;
      const writer = { actor: me, via: "owner", askedBy: me.personId } as const;
      // None set yet: the host's zone stood in, and its days are the ones people saw.
      const host = unsetOwnerZone();
      const { row: due } = yield* records.create(orgA, writer, {
        originKey: "due",
        title: "Invented: send the plan",
        owner: me,
        dueAt: endOfDay("2026-11-27", host),
        dueAllDay: true,
      });
      const timed = Date.parse("2026-11-27T09:30:00.000Z");
      const { row: call } = yield* records.create(orgA, writer, {
        originKey: "call",
        title: "Invented: call Meera",
        owner: me,
        dueAt: timed,
      });
      const work = yield* Stream.toQueue(records.changes(orgA), { capacity: "unbounded" });
      const first = yield* Queue.take(work);
      const read = Effect.gen(function* () {
        const zone = yield* ownerZone(orgA);
        const at = (yield* records.get(orgA, due.key))!.dueAt!;
        // Its day, and late only once that day is over where the company now is.
        return [
          dayIn(at, zone),
          at === endOfDay("2026-11-27", zone),
          (yield* records.get(orgA, call.key))!.dueAt,
        ];
      });
      for (const zone of ["Asia/Kolkata", "America/Bogota", "Pacific/Auckland"]) {
        yield* routines.setTimeZone(orgA, zone);
        assert.deepStrictEqual(yield* read, ["2026-11-27", true, timed], zone);
      }
      assert.isAbove((yield* Queue.take(work)).seq, first.seq);
      // A re-anchor that fails takes the zone change with it: the zone and the days agree.
      yield* sql`CREATE TRIGGER refuse_due BEFORE UPDATE OF due_at ON kin_records
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      yield* Effect.flip(routines.setTimeZone(orgA, "Asia/Tokyo"));
      assert.strictEqual(yield* ownerZone(orgA), "Pacific/Auckland");
      assert.deepStrictEqual(yield* read, ["2026-11-27", true, timed]);
    }).pipe(Effect.provide(fixture())),
);

// Walk 6 (Nov 2026): changing the company's quiet hours left what was already held on the old ones.
it.effect("a change to the company's quiet hours moves what is held for its people", () =>
  Effect.gen(function* () {
    yield* seed();
    const routines = yield* Routines.KinRoutines;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-11-09T01:00:00.000Z"));
    const night = { ...settings, timeZone: "UTC", quietHours: { from: "22:00", to: "07:00" } };
    yield* routines.configure(night);
    // A teammate on the company's clock, holding nothing to working hours; one line waits for
    // 07:00, one for a time of its own (a nudge for 09:00).
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
      hold_outside_hours) VALUES ('zoya-a', ${orgA}, 'zoya', 'Zoya', '2026-11-07T00:00:00.000Z', 0)`;
    for (const [id, at] of [
      ["quiet", "2026-11-09T07:00:00.000Z"],
      ["own", "2026-11-09T09:00:00.000Z"],
    ] as const)
      yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
        audience, held_at, deliver_at)
      VALUES (${id}, ${orgA}, ${`chat-${orgA}`}, 'zoya-a', ${id}, 'Invented line', 'chat',
        ${Date.parse("2026-11-09T01:00:00.000Z")}, ${Date.parse(at)})`;
    const held = sql<{ id: string; at: string }>`SELECT hold_id AS id, deliver_at AS at
      FROM kin_held_posts WHERE org_id = ${orgA} ORDER BY hold_id`;
    yield* routines.configure({ ...night, quietHours: { from: "22:00", to: "05:00" } });
    assert.deepStrictEqual(
      (yield* held).map((row) => [row.id, Number(row.at)]),
      [
        ["own", Date.parse("2026-11-09T09:00:00.000Z")],
        ["quiet", Date.parse("2026-11-09T05:00:00.000Z")],
      ],
    );
    // Hours that already ended let it go at once.
    yield* routines.configure({ ...night, quietHours: { from: "22:00", to: "00:30" } });
    assert.deepStrictEqual(
      (yield* held).map((row) => [row.id, Number(row.at)]),
      [
        ["own", Date.parse("2026-11-09T09:00:00.000Z")],
        ["quiet", Date.parse("2026-11-09T01:00:00.000Z")],
      ],
    );
  }).pipe(Effect.provide(fixture())),
);
