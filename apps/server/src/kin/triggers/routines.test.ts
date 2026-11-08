import { assert, it } from "@effect/vitest";
import { KinOrgId, KinTriggerId, KinEvent, type KinTriggerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
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

it.effect("consumes a failing fire and still delivers the following good fire", () =>
  Effect.gen(function* () {
    yield* seed();
    const routines = yield* Routines.KinRoutines;
    const scheduler = yield* TriggerScheduler.KinTriggerScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-11-09T02:00:00.000Z"));
    yield* routines.configure(settings);
    yield* TestClock.setTime(Date.parse("2026-11-09T13:00:00.000Z"));
    yield* scheduler.runDue();
    yield* sql`CREATE TRIGGER reject_fold BEFORE INSERT ON kin_routine_folds BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
    yield* routines.drain(orgA);
    const rows = yield* sql<{
      json: string;
    }>`SELECT json FROM kin_events WHERE org_id = ${orgA} AND tag = 'routine' ORDER BY event_id`;
    assert.isTrue(
      rows.some((row) => {
        const event = decodeEventJson(row.json);
        return (
          event._tag === "routine" && event.routine === "evening_summary" && event.lateByMs === 0
        );
      }),
    );
    assert.lengthOf(
      yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgA} AND consumed_at IS NULL ORDER BY fire_id`,
      0,
    );
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
