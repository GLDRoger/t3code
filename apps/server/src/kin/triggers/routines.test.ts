import { assert, it } from "@effect/vitest";
import {
  KinOrgId,
  KinPersonId,
  KinTriggerId,
  KinEvent,
  type KinTriggerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Memory from "../memory/Memory.ts";
import * as OwnerTimeZone from "./ownerTimeZone.ts";
import * as Routines from "./routines.ts";
import * as TriggerScheduler from "./KinTriggerScheduler.ts";
import * as TriggerStore from "./KinTriggerStore.ts";
import { fixture, seed, orgId as orgA, otherOrg } from "./routines.testkit.ts";
import { routineDisposition } from "./routines.ts";

const decodeEventJson = Schema.decodeSync(Schema.fromJsonString(KinEvent));
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
it.effect("folds late briefs and summaries at their owner-local boundaries", () =>
  Effect.sync(() => {
    for (const [routine, due, now, expected] of [
      ["morning_brief", "2026-11-09T03:00:00.000Z", "2026-11-09T12:59:59.999Z", "post"],
      ["morning_brief", "2026-11-09T03:00:00.000Z", "2026-11-09T13:00:00.000Z", "fold"],
      ["evening_summary", "2026-11-09T13:00:00.000Z", "2026-11-09T21:29:59.999Z", "post"],
      ["evening_summary", "2026-11-09T13:00:00.000Z", "2026-11-09T21:30:00.000Z", "fold"],
      ["owner_check", "2026-11-09T03:30:00.000Z", "2026-11-12T13:00:00.000Z", "post"],
    ] as const)
      assert.equal(routineDisposition(routine, due, now, settings), expected);
  }),
);

it.effect(
  "emits one routine per org at owner time, survives replay, and folds expired slots durably",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const routines = yield* Routines.KinRoutines;
      const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-09T02:59:59.999Z"));
      for (const orgId of [orgA, otherOrg]) yield* routines.configure({ ...settings, orgId });
      yield* scheduler.runDue();
      yield* routines.drain(orgA);
      assert.lengthOf(
        yield* sql`SELECT event_id FROM kin_events WHERE org_id = ${orgA} ORDER BY event_id`,
        0,
      );
      yield* TestClock.adjust(1);
      yield* scheduler.runDue();
      for (const orgId of [orgA, otherOrg]) yield* routines.drain(orgId);
      const rows = yield* sql<{
        dedupe_key: string;
        json: string;
      }>`SELECT dedupe_key, json FROM kin_events WHERE org_id IN (${orgA}, ${otherOrg}) ORDER BY org_id, event_id`;
      assert.lengthOf(rows, 2);
      assert.equal(new Set(rows.map((row) => row.dedupe_key)).size, 2);
      assert.equal(decodeEventJson(rows[0]!.json)._tag, "routine");
      yield* TestClock.setTime(Date.parse("2026-11-09T13:00:00.000Z"));
      yield* scheduler.runDue();
      yield* routines.drain(orgA);
      assert.lengthOf(
        yield* sql`SELECT event_id FROM kin_events WHERE org_id = ${orgA} ORDER BY event_id`,
        3,
      );
      // Replay an already consumed inbox row, as after a crash before the consume marker.
      yield* sql`UPDATE kin_trigger_inbox SET consumed_at = NULL WHERE org_id = ${orgA}`;
      yield* routines.drain(orgA);
      assert.lengthOf(
        yield* sql`SELECT event_id FROM kin_events WHERE org_id = ${orgA} ORDER BY event_id`,
        3,
      );
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "folds a brief after summary time and a summary after the next dream without duplicate catch-up",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const routines = yield* Routines.KinRoutines;
      const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-09T02:00:00.000Z"));
      yield* routines.configure(settings);
      yield* TestClock.setTime(Date.parse("2026-11-09T13:00:00.000Z"));
      yield* scheduler.runDue();
      yield* routines.drain(orgA);
      const rows = yield* sql<{
        json: string;
      }>`SELECT json FROM kin_events WHERE org_id = ${orgA} AND tag = 'routine' ORDER BY event_id`;
      const events = rows.map((row) => decodeEventJson(row.json));
      assert.isFalse(
        events.some((event) => event._tag === "routine" && event.routine === "morning_brief"),
      );
      const summary = events.find(
        (event) => event._tag === "routine" && event.routine === "evening_summary",
      );
      assert.equal(summary?._tag, "routine");
      if (summary?._tag === "routine")
        assert.equal(summary.foldedRoutines?.[0]?.routine, "morning_brief");
      yield* TestClock.setTime(Date.parse("2026-11-10T03:00:00.000Z"));
      yield* scheduler.runDue();
      yield* routines.drain(orgA);
      yield* TestClock.setTime(Date.parse("2026-11-11T03:00:00.000Z"));
      yield* scheduler.runDue();
      yield* routines.drain(orgA);
      const [latest] = yield* sql<{
        json: string;
      }>`SELECT json FROM kin_events WHERE org_id = ${orgA} AND json_extract(json, '$.routine') = 'morning_brief' ORDER BY received_at DESC LIMIT 1`;
      const brief = decodeEventJson(latest!.json);
      assert.equal(brief._tag, "routine");
      if (brief._tag === "routine")
        assert.equal(brief.foldedRoutines?.[0]?.routine, "evening_summary");
      assert.lengthOf(
        yield* sql`SELECT fire_id FROM kin_routine_folds WHERE org_id = ${orgA} ORDER BY fire_id`,
        0,
      );
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "disarms and re-arms individual routines and preserves opt-outs across pause, restart and timezone changes",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const routines = yield* Routines.KinRoutines;
      const store = yield* TriggerStore.KinTriggerStore;
      const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
      yield* TestClock.setTime(Date.parse("2026-03-07T12:00:00.000Z"));
      yield* routines.configure({ ...settings, timeZone: "America/New_York" });
      const id = KinTriggerId.make("routine:morning_brief");
      assert.equal((yield* store.get(orgA, id))?.nextRunAt, "2026-03-07T13:30:00.000Z");
      yield* TestClock.setTime(Date.parse("2026-03-07T13:30:00.000Z"));
      yield* scheduler.runDue();
      assert.equal((yield* store.get(orgA, id))?.nextRunAt, "2026-03-08T12:30:00.000Z");
      yield* routines.drain(orgA);
      const sql = yield* SqlClient.SqlClient;
      yield* routines.setEnabled(orgA, "morning_brief", false);
      assert.deepEqual(
        yield* sql`SELECT state FROM kin_events WHERE org_id = ${orgA} AND json_extract(json, '$.routine') = 'morning_brief' ORDER BY event_id`,
        [{ state: "expired" }],
      );
      assert.isNull((yield* store.get(orgA, id))?.nextRunAt);
      yield* routines.configure(settings).pipe(Effect.provide(Layer.fresh(Routines.layer)));
      assert.isFalse((yield* store.get(orgA, id))?.enabled);
      yield* routines.pauseAll(orgA);
      assert.isTrue((yield* store.list(orgA)).every((trigger) => !trigger.enabled));
      yield* routines.resumeAll(orgA);
      assert.isFalse((yield* store.get(orgA, id))?.enabled);
      yield* routines.setEnabled(orgA, "morning_brief", true);
      assert.equal((yield* store.get(orgA, id))?.nextRunAt, "2026-03-08T03:00:00.000Z");
      yield* TestClock.setTime(Date.parse("2026-03-08T03:01:00.000Z"));
      yield* routines.configure({ ...settings, timeZone: "America/New_York" });
      assert.equal((yield* store.get(orgA, id))?.nextRunAt, "2026-03-08T03:00:00.000Z");
      yield* scheduler.runDue();
      assert.equal((yield* store.get(orgA, id))?.nextRunAt, "2026-03-08T12:30:00.000Z");
      yield* TestClock.setTime(Date.parse("2026-10-31T12:00:00.000Z"));
      yield* scheduler.runDue();
      yield* TestClock.setTime(Date.parse("2026-10-31T12:30:00.000Z"));
      yield* scheduler.runDue();
      assert.equal((yield* store.get(orgA, id))?.nextRunAt, "2026-11-01T13:30:00.000Z");
      yield* sql`UPDATE kin_agents SET retired_at = '2026-11-01T13:00:00.000Z' WHERE org_id = ${orgA} AND agent_id = 'lead-a'`;
      yield* routines.drain(orgA);
      yield* routines.configure(settings);
      assert.isTrue((yield* store.list(orgA)).every((trigger) => !trigger.enabled));
      assert.lengthOf(
        yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgA} AND consumed_at IS NULL ORDER BY fire_id`,
        0,
      );
    }).pipe(Effect.provide(fixture())),
);

it.effect("the owner's time zone reschedules routines from the defaults; others are refused", () =>
  Effect.gen(function* () {
    yield* seed();
    const routines = yield* Routines.KinRoutines;
    const store = yield* TriggerStore.KinTriggerStore;
    const sql = yield* SqlClient.SqlClient;
    const zones = yield* OwnerTimeZone.KinOwnerTimeZone;
    yield* zones.attach(routines);
    yield* TestClock.setTime(Date.parse("2026-11-09T00:00:00.000Z"));
    yield* routines.setEnabled(orgA, "morning_brief", true);
    const brief = KinTriggerId.make("routine:morning_brief");
    const dream = KinTriggerId.make("routine:dream");
    assert.equal((yield* store.get(orgA, brief))?.nextRunAt, "2026-11-09T08:30:00.000Z");
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
    for (const call of [zones.set(member, input), zones.get(member, input)])
      assert.include(yield* call.pipe(Effect.flip), { reason: "not_allowed" });
    assert.include(
      yield* zones.set(owner, { ...input, timeZone: "Mars/Olympus" }).pipe(Effect.flip),
      { reason: "invalid_state" },
    );
    assert.equal((yield* store.get(orgA, brief))?.timeZone, "UTC");

    assert.deepEqual(yield* zones.set(owner, input), input);
    assert.deepEqual(yield* zones.get(owner, input), input);
    // 08:30 and 03:00 in Kolkata; the dream's slot today has passed there.
    assert.equal((yield* store.get(orgA, brief))?.nextRunAt, "2026-11-09T03:00:00.000Z");
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

it.effect.each(["transient", "decode", "expired"] as const)(
  "handles a %s failure without blocking the following good fire",
  (failure) =>
    Effect.gen(function* () {
      yield* seed();
      const routines = yield* Routines.KinRoutines;
      const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-09T02:00:00.000Z"));
      yield* routines.configure(settings);
      yield* TestClock.setTime(Date.parse("2026-11-09T13:00:00.000Z"));
      yield* scheduler.runDue();
      if (failure === "decode")
        yield* sql`INSERT INTO kin_routine_folds VALUES (${orgA}, 'bad-fold', 'invalid-routine', 1, 'evening_summary')`;
      else
        yield* sql`CREATE TRIGGER reject_fold BEFORE INSERT ON kin_routine_folds BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      if (failure === "expired") {
        yield* routines.drain(orgA);
        assert.lengthOf(
          yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgA} AND consumed_at IS NULL`,
          1,
        );
        yield* TestClock.adjust("25 hours");
      }
      yield* routines.drain(orgA);
      const rows = yield* sql<{
        json: string;
      }>`SELECT json FROM kin_events WHERE org_id = ${orgA} AND tag = 'routine' ORDER BY event_id`;
      assert.equal(
        rows.some((row) => {
          const event = decodeEventJson(row.json);
          return (
            event._tag === "routine" && event.routine === "evening_summary" && event.lateByMs === 0
          );
        }),
        failure !== "decode",
      );
      assert.lengthOf(
        yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgA} AND consumed_at IS NULL ORDER BY fire_id`,
        failure === "transient" ? 1 : 0,
      );
      if (failure === "transient") {
        yield* sql`DROP TRIGGER reject_fold`;
        yield* routines.drain(orgA);
        assert.lengthOf(
          yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgA} AND consumed_at IS NULL`,
          0,
        );
      }
    }).pipe(Effect.provide(fixture())),
);

it.effect.each([false, true])(
  "repoints stranded folds, or drops them when both routines are off: %s",
  (bothOff) =>
    Effect.gen(function* () {
      yield* seed();
      const routines = yield* Routines.KinRoutines;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-09T02:00:00.000Z"));
      yield* routines.configure(settings);
      yield* sql`INSERT INTO kin_routine_folds VALUES (${orgA}, 'old-fire', 'morning_brief', 1, 'evening_summary')`;
      yield* routines.setEnabled(orgA, "evening_summary", false);
      const folds = yield* sql<{
        fold_into: string;
      }>`SELECT fold_into FROM kin_routine_folds WHERE org_id = ${orgA} ORDER BY fire_id`;
      assert.deepEqual(folds, [{ fold_into: "morning_brief" }]);
      if (bothOff) {
        yield* routines.setEnabled(orgA, "morning_brief", false);
        assert.lengthOf(
          yield* sql`SELECT fire_id FROM kin_routine_folds WHERE org_id = ${orgA} ORDER BY fire_id`,
          0,
        );
      } else {
        const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
        yield* TestClock.setTime(Date.parse("2026-11-09T03:00:00.000Z"));
        yield* scheduler.runDue();
        yield* routines.drain(orgA);
        const [row] = yield* sql<{
          json: string;
        }>`SELECT json FROM kin_events WHERE org_id = ${orgA} ORDER BY event_id LIMIT 1`;
        const event = decodeEventJson(row!.json);
        assert.equal(event._tag, "routine");
        if (event._tag === "routine")
          assert.equal(event.foldedRoutines?.[0]?.routine, "morning_brief");
      }
    }).pipe(Effect.provide(fixture())),
);

it.effect("waits for Memory's org lock without holding SQLite's writer", () =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const held = yield* Deferred.make<void>();
    const selecting = yield* Deferred.make<boolean>();
    const write = yield* Deferred.make<boolean>();
    yield* Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const routines = yield* Routines.KinRoutines;
      const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
      yield* TestClock.setTime(Date.parse("2026-11-09T03:29:59.000Z"));
      yield* routines.configure(settings);
      yield* TestClock.adjust("1 second");
      yield* scheduler.runDue();
      const holder = yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            const canWrite = yield* Deferred.await(write);
            if (canWrite)
              yield* sql.withTransaction(
                sql`UPDATE kin_orgs SET name = 'Memory anchor' WHERE org_id = ${orgA}`,
              );
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const drain = yield* routines.drain(orgA).pipe(Effect.forkScoped);
      const inTransaction = yield* Deferred.await(selecting);
      yield* Deferred.succeed(write, !inTransaction);
      yield* Fiber.join(holder);
      yield* Fiber.join(drain);
      assert.isFalse(inTransaction);
      assert.lengthOf(
        yield* sql`SELECT event_id FROM kin_events WHERE org_id = ${orgA} AND json_extract(json, '$.routine') = 'owner_check'`,
        1,
      );
    }).pipe(
      Effect.provide(
        fixture([], {
          query: (sql) => () =>
            Effect.gen(function* () {
              const transaction = yield* Effect.serviceOption(sql.transactionService);
              yield* Deferred.succeed(selecting, Option.isSome(transaction));
              return yield* lock.withPermits(1)(Effect.succeed([]));
            }),
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

const decodeNoItems = Schema.decodeUnknownEffect(Schema.Array(Schema.Never));

it.effect("consumes an owner check whose selection fails to decode", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const routines = yield* Routines.KinRoutines;
    const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
    yield* TestClock.setTime(Date.parse("2026-11-09T03:29:59.000Z"));
    yield* routines.configure(settings);
    yield* TestClock.adjust("1 second");
    yield* scheduler.runDue();
    yield* routines.drain(orgA);
    assert.lengthOf(
      yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgA} AND consumed_at IS NULL ORDER BY fire_id`,
      0,
    );
    assert.lengthOf(
      yield* sql`SELECT event_id FROM kin_events WHERE org_id = ${orgA} AND json_extract(json, '$.routine') = 'owner_check' ORDER BY event_id`,
      0,
    );
  }).pipe(
    Effect.provide(
      fixture([], {
        query: () => () =>
          decodeNoItems(["bad"]).pipe(
            Effect.mapError(
              (cause) => new Memory.MemoryError({ orgId: orgA, operation: "query", cause }),
            ),
          ),
      }),
    ),
  ),
);

it.effect("reconciles at fifteen minutes, not intervening five-second ticks", () =>
  Effect.gen(function* () {
    let tick = Effect.void;
    yield* Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* tick;
      yield* sql`DELETE FROM kin_triggers WHERE org_id = ${orgA} AND trigger_id = 'routine:owner_check'`;
      for (let index = 1; index < 180; index++) {
        yield* TestClock.adjust("5 seconds");
        yield* tick;
        assert.lengthOf(
          yield* sql`SELECT trigger_id FROM kin_triggers WHERE org_id = ${orgA} AND trigger_id = 'routine:owner_check'`,
          0,
        );
      }
      yield* TestClock.adjust("5 seconds");
      yield* tick;
      assert.lengthOf(
        yield* sql`SELECT trigger_id FROM kin_triggers WHERE org_id = ${orgA} AND trigger_id = 'routine:owner_check'`,
        1,
      );
    }).pipe(
      Effect.provide(
        fixture([], {
          register: Effect.fn(function* <E, R>(name: string, work: Effect.Effect<void, E, R>) {
            if (name === "kin-routines") {
              const context = yield* Effect.context<R>();
              tick = work.pipe(Effect.provideContext(context), Effect.orDie);
            }
          }),
        }),
      ),
    );
  }),
);
