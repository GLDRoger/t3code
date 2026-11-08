import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinTrigger, KinTriggerSettings } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerScheduler from "./KinTriggerScheduler.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

const database = KinPersistence.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const stores = Layer.merge(KinTriggerStore.layer, KinTriggerInbox.layer).pipe(
  Layer.provideMerge(database),
  Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
);
const layer = KinTriggerScheduler.layer.pipe(
  Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
  Layer.provideMerge(stores),
);
const orgA = Schema.decodeSync(KinOrgId)("org-a");
const orgB = Schema.decodeSync(KinOrgId)("org-b");
const timestamp = "2026-11-07T00:00:00.000Z";
const millis = (time: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(time));
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  for (const org of [orgA, orgB]) {
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, 'Kin', ${timestamp})`;
  }
});

const decodeTrigger = Schema.decodeSync(KinTrigger);
const decodeSettings = Schema.decodeSync(KinTriggerSettings);
const decodeOverrides = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

function trigger(overrides: unknown) {
  return decodeTrigger({
    id: "trigger",
    orgId: orgA,
    subject: { type: "routine", routine: "morning_brief" },
    schedule: { type: "fixed_time", timeOfDay: "09:00" },
    timeZone: "Asia/Kolkata",
    enabled: true,
    nextRunAt: timestamp,
    lastFireId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...decodeOverrides(overrides),
  });
}

function settings(orgId = orgA, timeZone = "Asia/Kolkata") {
  return decodeSettings({
    orgId,
    timeZone,
    morningBrief: "09:00",
    eveningSummary: "18:30",
    dream: "03:00",
    fullRebuildWeekday: 0,
    ownerCheckWeekday: 1,
    ownerCheck: "09:00",
    quietHours: { from: "21:00", to: "08:00" },
  });
}

describe("KinTriggerScheduler", () => {
  it.effect("keeps local routine time through DST and respects weekdays, intervals and once", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const cases = [
        { zone: "Asia/Kolkata", due: "2026-11-07T03:30:00.000Z", next: "2026-11-08T03:30:00.000Z" },
        {
          zone: "America/New_York",
          due: "2026-03-07T14:00:00.000Z",
          next: "2026-03-08T13:00:00.000Z",
        },
        {
          zone: "America/New_York",
          due: "2026-03-08T13:00:00.000Z",
          next: "2026-03-09T13:00:00.000Z",
        },
        {
          zone: "America/New_York",
          due: "2026-10-31T13:00:00.000Z",
          next: "2026-11-01T14:00:00.000Z",
        },
        {
          zone: "America/New_York",
          due: "2026-11-01T14:00:00.000Z",
          next: "2026-11-02T14:00:00.000Z",
        },
        {
          zone: "America/New_York",
          due: "2026-11-06T14:00:00.000Z",
          next: "2026-11-09T14:00:00.000Z",
          weekdays: [1, 2, 3, 4, 5],
        },
        {
          zone: "America/New_York",
          timeOfDay: "01:30",
          due: "2026-11-01T05:30:00.000Z",
          next: "2026-11-02T06:30:00.000Z",
        },
        {
          zone: "America/New_York",
          timeOfDay: "02:30",
          due: "2027-03-14T07:30:00.000Z",
          next: "2027-03-15T06:30:00.000Z",
        },
      ];
      for (const [index, row] of cases.entries()) {
        const value = trigger({
          id: `calendar-${index}`,
          timeZone: row.zone,
          nextRunAt: row.due,
          schedule: {
            type: "fixed_time",
            timeOfDay: row.timeOfDay ?? "09:00",
            weekdays: row.weekdays,
          },
        });
        yield* store.put(value);
        yield* TestClock.setTime(millis(row.due) - 1);
        yield* scheduler.runDue();
        assert.isFalse(
          (yield* inbox.listPending(orgA)).some((event) => event.fireId.startsWith(`${value.id}:`)),
        );
        yield* TestClock.adjust(1);
        yield* scheduler.runDue();
        assert.strictEqual((yield* store.get(orgA, value.id))?.nextRunAt, row.next);
        const events = (yield* inbox.listPending(orgA)).filter((event) =>
          event.fireId.startsWith(`${value.id}:`),
        );
        assert.lengthOf(events, 1);
        assert.strictEqual(events[0]?.dueAt, row.due);
        assert.strictEqual(events[0]?.lateByMs, 0);
        yield* TestClock.adjust("1 hour");
        yield* scheduler.runDue();
        assert.lengthOf(
          (yield* inbox.listPending(orgA)).filter((event) =>
            event.fireId.startsWith(`${value.id}:`),
          ),
          1,
        );
        yield* store.delete(orgA, value.id);
      }
      for (const type of ["interval", "once"]) {
        const due = "2026-03-08T06:59:30.000Z";
        const value = trigger({
          id: type,
          timeZone: "America/New_York",
          nextRunAt: due,
          schedule: type === "interval" ? { type, everyMs: 60000 } : { type, runAt: due },
        });
        yield* store.put(value);
        yield* TestClock.setTime(millis(due));
        yield* scheduler.runDue();
        assert.strictEqual(
          (yield* store.get(orgA, value.id))?.nextRunAt,
          type === "once" ? null : "2026-03-08T07:00:30.000Z",
        );
        yield* scheduler.runDue();
        assert.lengthOf(
          (yield* inbox.listPending(orgA)).filter((event) => event.fireId.startsWith(`${type}:`)),
          1,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fires non-canonical stored schedules once and advances them", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const sql = yield* SqlClient.SqlClient;
      const due = "2026-11-07T03:00:00.000Z";
      const cases = [
        ['{ "timeOfDay": "05:00", "type": "fixed_time" }', "2026-11-07T05:00:00.000Z"],
        [
          '{ "extra": true, "type": "fixed_time", "timeOfDay": "05:00" }',
          "2026-11-07T05:00:00.000Z",
        ],
        [
          '{ "weekdays": [6], "timeOfDay": "05:00", "type": "fixed_time" }',
          "2026-11-07T05:00:00.000Z",
        ],
        ['{ "everyMs": 60000, "type": "interval" }', "2026-11-07T03:01:00.000Z"],
      ];
      for (const [index, [schedule, next]] of cases.entries()) {
        const value = trigger({ id: `non-canonical-${index}`, timeZone: "UTC", nextRunAt: due });
        yield* store.put(value);
        yield* sql`UPDATE kin_triggers SET schedule_json = ${schedule}
          WHERE org_id = ${orgA} AND trigger_id = ${value.id}`;
        yield* TestClock.setTime(millis(due));
        yield* scheduler.runDue();
        assert.strictEqual((yield* store.get(orgA, value.id))?.nextRunAt, next);
      }
      for (let tick = 0; tick < 5; tick++) yield* scheduler.runDue();
      const events = yield* inbox.listPending(orgA);
      assert.lengthOf(events, cases.length);
      assert.isTrue(events.every((event) => event.dueAt === due));
      assert.lengthOf(
        yield* sql`SELECT fire_id FROM kin_trigger_fires ORDER BY fire_id`,
        cases.length,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fires overdue slots once without backfill or dropping late heads-ups", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const due = "2026-11-01T03:30:00.000Z";
      const now = "2026-11-07T14:00:00.000Z";
      for (const value of [
        trigger({ id: "routine", nextRunAt: due }),
        trigger({
          id: "watchdog",
          nextRunAt: due,
          schedule: { type: "interval", everyMs: 60000 },
          subject: { type: "watchdog", watchdog: "github_recheck" },
        }),
        trigger({
          id: "once",
          nextRunAt: due,
          schedule: { type: "once", runAt: due },
          subject: { type: "deferral", itemId: "item", phase: "heads_up" },
        }),
      ])
        yield* store.put(value);
      yield* TestClock.setTime(millis(now));
      yield* scheduler.runDue();
      yield* scheduler.runDue();
      const events = yield* inbox.listPending(orgA);
      assert.lengthOf(events, 3);
      for (const event of events) {
        assert.strictEqual(event.dueAt, due);
        assert.strictEqual(event.firedAt, now);
        assert.strictEqual(event.lateByMs, millis(now) - millis(due));
      }
      assert.strictEqual(
        (yield* store.get(orgA, trigger({ id: "routine" }).id))?.nextRunAt,
        "2026-11-08T03:30:00.000Z",
      );
      assert.strictEqual(
        (yield* store.get(orgA, trigger({ id: "watchdog" }).id))?.nextRunAt,
        "2026-11-07T14:01:00.000Z",
      );
      assert.isNull((yield* store.get(orgA, trigger({ id: "once" }).id))?.nextRunAt);
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT fire_id FROM kin_trigger_fires ORDER BY fire_id`, 3);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "recomputes org settings without moving absolute once times or affecting another org",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* TestClock.setTime(millis(timestamp));
        const store = yield* KinTriggerStore.KinTriggerStore;
        const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        for (const orgId of [orgA, orgB]) {
          for (const routine of [
            "morning_brief",
            "evening_summary",
            "dream",
            "dream_full",
            "owner_check",
          ]) {
            yield* store.put(
              trigger({
                id: routine,
                orgId,
                nextRunAt: null,
                timeZone: "UTC",
                subject: { type: "routine", routine },
              }),
            );
          }
        }
        const once = trigger({
          id: "once",
          subject: { type: "reminder", itemId: "item" },
          schedule: { type: "once", runAt: timestamp },
        });
        yield* store.put(once);
        yield* store.put(trigger({ id: "disabled", enabled: false }));
        yield* scheduler.recompute(settings());
        assert.deepStrictEqual(yield* store.get(orgA, once.id), {
          ...once,
          timeZone: new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata" }).resolvedOptions()
            .timeZone,
        });
        const before = yield* store.list(orgA);
        yield* TestClock.adjust("1 second");
        yield* scheduler.recompute(settings(orgA, "asia/kolkata"));
        assert.deepStrictEqual(yield* store.list(orgA), before);
        yield* TestClock.setTime(millis(timestamp));
        assert.isNull((yield* store.get(orgA, trigger({ id: "disabled" }).id))?.nextRunAt);
        for (const [id, next] of [
          ["morning_brief", "2026-11-07T03:30:00.000Z"],
          ["evening_summary", "2026-11-09T13:00:00.000Z"],
          ["dream", "2026-11-07T21:30:00.000Z"],
          ["dream_full", "2026-11-07T21:30:00.000Z"],
          ["owner_check", "2026-11-09T03:30:00.000Z"],
        ])
          assert.strictEqual((yield* store.get(orgA, trigger({ id }).id))?.nextRunAt, next);
        assert.isNull((yield* store.get(orgB, trigger({ id: "morning_brief" }).id))?.nextRunAt);
        yield* scheduler.recompute(settings(orgB, "America/New_York"));
        yield* scheduler.runDue();
        yield* TestClock.adjust("210 minutes");
        yield* scheduler.runDue();
        assert.lengthOf(yield* inbox.listPending(orgA), 2);
        assert.lengthOf(yield* inbox.listPending(orgB), 0);
        yield* TestClock.adjust("630 minutes");
        yield* scheduler.runDue();
        assert.lengthOf(yield* inbox.listPending(orgA), 2);
        assert.lengthOf(yield* inbox.listPending(orgB), 2);
        yield* scheduler.recompute({ ...settings(), morningBrief: "10:00" });
        assert.strictEqual(
          (yield* store.get(orgA, trigger({ id: "morning_brief" }).id))?.nextRunAt,
          "2026-11-08T04:30:00.000Z",
        );
        assert.strictEqual(
          (yield* store.get(orgB, trigger({ id: "morning_brief" }).id))?.nextRunAt,
          "2026-11-08T14:00:00.000Z",
        );
        assert.isNull((yield* store.get(orgA, once.id))?.nextRunAt);
        const overdue = trigger({
          id: "overdue",
          nextRunAt: "2026-11-07T14:00:00.000Z",
        });
        const interval = trigger({
          id: "interval",
          subject: { type: "watchdog", watchdog: "github_recheck" },
          schedule: { type: "interval", everyMs: 6 * 60 * 60 * 1000 },
          nextRunAt: "2026-11-07T20:00:00.000Z",
        });
        yield* store.put(overdue);
        yield* store.put(interval);
        const unarmedInterval = trigger({ ...interval, id: "unarmed-interval", nextRunAt: null });
        yield* store.put(unarmedInterval);
        yield* TestClock.adjust("3 seconds");
        const changed = { ...settings(orgA, "UTC"), morningBrief: "16:00" };
        yield* scheduler.recompute(changed);
        assert.strictEqual(
          (yield* store.get(orgA, unarmedInterval.id))?.nextRunAt,
          "2026-11-07T20:00:03.000Z",
        );
        assert.deepStrictEqual(
          [
            (yield* store.get(orgA, overdue.id))?.nextRunAt,
            (yield* store.get(orgA, interval.id))?.nextRunAt,
          ],
          [overdue.nextRunAt, interval.nextRunAt],
        );
        yield* scheduler.runDue();
        yield* scheduler.runDue();
        const events = (yield* inbox.listPending(orgA)).filter((event) =>
          event.fireId.startsWith(`${overdue.id}:`),
        );
        assert.lengthOf(events, 1);
        assert.strictEqual(events[0]?.dueAt, overdue.nextRunAt);
        assert.strictEqual(events[0]?.lateByMs, 3000);
        assert.strictEqual(
          (yield* store.get(orgA, overdue.id))?.nextRunAt,
          "2026-11-07T16:00:00.000Z",
        );
        const unchanged = yield* store.list(orgA);
        yield* TestClock.adjust("1 second");
        yield* scheduler.recompute(changed);
        assert.deepStrictEqual(yield* store.list(orgA), unchanged);
        yield* scheduler.recompute({ ...changed, eveningSummary: "19:00" });
        assert.deepStrictEqual(
          yield* store.get(orgA, interval.id),
          unchanged.find((value) => value.id === interval.id),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("uses settings saved between the due scan and fire without losing the slot", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const due = "2026-11-07T03:00:00.000Z";
      const value = trigger({
        timeZone: "UTC",
        schedule: { type: "fixed_time", timeOfDay: "03:00" },
        nextRunAt: due,
      });
      yield* store.put(value);
      yield* TestClock.setTime(millis(due) + 3000);
      const observedStore = KinTriggerStore.KinTriggerStore.of({
        ...store,
        fire: (...args) =>
          scheduler
            .recompute({ ...settings(orgA, "UTC"), morningBrief: "05:00" })
            .pipe(Effect.andThen(store.fire(...args))),
      });
      yield* Effect.gen(function* () {
        const hooked = yield* KinTriggerScheduler.KinTriggerScheduler;
        yield* hooked.runDue();
        assert.lengthOf(yield* inbox.listPending(orgA), 1);
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(yield* sql`SELECT fire_id FROM kin_trigger_fires ORDER BY fire_id`, 1);
        assert.strictEqual(
          (yield* store.get(orgA, value.id))?.nextRunAt,
          "2026-11-07T05:00:00.000Z",
        );
        yield* hooked.runDue();
        yield* hooked.runDue();
      }).pipe(
        Effect.provide(
          Layer.fresh(KinTriggerScheduler.layer).pipe(
            Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
            Layer.provide(Layer.succeed(KinTriggerStore.KinTriggerStore, observedStore)),
          ),
        ),
      );
      const events = yield* inbox.listPending(orgA);
      assert.lengthOf(events, 1);
      assert.strictEqual(events[0]?.dueAt, due);
      assert.strictEqual(events[0]?.lateByMs, 3000);
      assert.strictEqual((yield* store.get(orgA, value.id))?.nextRunAt, "2026-11-07T05:00:00.000Z");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "continues through failed triggers and all due pages, then retries the failed row",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* TestClock.setTime(millis(timestamp));
        const sql = yield* SqlClient.SqlClient;
        const store = yield* KinTriggerStore.KinTriggerStore;
        const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        for (const id of ["bad", ...Array.from({ length: 102 }, (_, index) => `good-${index}`)]) {
          yield* store.put(trigger({ id }));
        }
        yield* sql`CREATE TRIGGER reject_bad BEFORE INSERT ON kin_trigger_inbox
        WHEN NEW.fire_id LIKE 'bad:%' BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END`;
        yield* scheduler.runDue();
        assert.lengthOf(yield* inbox.listPending(orgA, 200), 102);
        assert.strictEqual(
          (yield* store.get(orgA, trigger({ id: "bad" }).id))?.nextRunAt,
          timestamp,
        );
        yield* sql`DROP TRIGGER reject_bad`;
        yield* scheduler.runDue();
        yield* scheduler.runDue();
        assert.lengthOf(yield* inbox.listPending(orgA, 200), 103);
        assert.lengthOf(yield* sql`SELECT fire_id FROM kin_trigger_fires ORDER BY fire_id`, 103);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("processes downtime at startup and new due work on the scoped five-second tick", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.setTime(millis(timestamp));
      const store = yield* KinTriggerStore.KinTriggerStore;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const receipts = yield* Queue.unbounded<string>();
      const missed = "2026-11-06T14:00:00.000Z";
      yield* store.put(
        trigger({
          id: "startup",
          nextRunAt: missed,
          schedule: { type: "once", runAt: missed },
          subject: { type: "deferral", itemId: "item", phase: "due" },
        }),
      );
      yield* store.put(trigger({ id: "after-close", nextRunAt: "2026-11-08T00:00:00.000Z" }));
      const due = "2026-11-07T00:00:05.000Z";
      yield* store.put(
        trigger({ id: "tick", nextRunAt: due, schedule: { type: "once", runAt: due } }),
      );
      const observedStore = KinTriggerStore.KinTriggerStore.of({
        ...store,
        fire: (...args) =>
          store.fire(...args).pipe(Effect.tap(() => Queue.offer(receipts, args[0].fireId))),
      });
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* Queue.take(receipts), `startup:${millis(missed)}`);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(yield* Queue.take(receipts), `tick:${millis(due)}`);
        const events = yield* inbox.listPending(orgA);
        assert.lengthOf(events, 2);
        assert.strictEqual(events[0]?.lateByMs, 36000000);
        assert.strictEqual(events[1]?.lateByMs, 0);
      }).pipe(
        Effect.provide(
          KinTriggerScheduler.layer.pipe(
            Layer.provide(Scheduler.layer),
            Layer.provide(Layer.succeed(KinTriggerStore.KinTriggerStore, observedStore)),
          ),
        ),
      );
      yield* TestClock.adjust("1 day");
      assert.lengthOf(yield* inbox.listPending(orgA), 2);
    }).pipe(Effect.provide(stores)),
  );
});
