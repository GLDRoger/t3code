import { KinMemoryItemId, KinTriggerFired, type KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { recordSkips, slotsBetween, type SkipReason } from "../host/offlineSkips.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { ownerZone } from "../work/recordRows.ts";
import { inHoursAt } from "./nudge.ts";

/** A check-in the host slept through is still worth having this long after its window opened. */
const CATCH_UP_MS = 3 * 60 * 60_000;

const decodeFire = Schema.decodeEffect(KinTriggerFired);
const decodeDays = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Number)));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * When a check-in slot T3's scheduler skipped as too late should still fire, now: its window
 * start today, or undefined. Only once the scheduler has moved past it, and only when it has
 * not run since the window opened, on the same day, within `CATCH_UP_MS`.
 */
export const missedSlot = (
  task: {
    readonly timeOfDay: string;
    readonly weekdays: ReadonlyArray<number>;
    readonly nextRunAt: number | null;
    readonly lastRunAt: number | null;
  },
  now: number,
  zone: string,
) => {
  const opens = KinSchedules.timeOnDayOf(now, zone, task.timeOfDay);
  const weekDay = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone })).weekDay;
  if (task.weekdays.length > 0 && !task.weekdays.includes(weekDay)) return undefined;
  if (now < opens || now - opens >= CATCH_UP_MS) return undefined;
  if (task.nextRunAt === null || task.nextRunAt <= now) return undefined;
  if (task.lastRunAt !== null && task.lastRunAt >= opens) return undefined;
  return opens;
};

const STEP_MS = 5 * 60_000;

/**
 * Records the slots T3's scheduler passed over (it moved `nextRunAt` on without running them)
 * that this pass does not run: a check-in once its catch-up can no longer happen, any other Kin
 * schedule at once. T3 keeps no row for them; this pass is where Kin sees the gap.
 */
const recordPassed = Effect.fn("KinPulse.recordPassedSlots")(function* (
  orgId: KinOrgId,
  row: {
    readonly taskId: string;
    readonly checkIn: number;
    readonly since: number;
    readonly timeZone: string | null;
    readonly workHours: string | null;
  },
  task: Parameters<typeof missedSlot>[0],
  at: {
    readonly now: number;
    readonly zone: string;
    readonly owners: string;
    readonly firing: boolean;
  },
) {
  if (task.nextRunAt === null || task.nextRunAt <= at.now) return;
  const slots = slotsBetween(
    { type: "fixed_time", timeOfDay: task.timeOfDay, weekdays: [...task.weekdays] },
    at.zone,
    Math.max(task.lastRunAt ?? 0, row.since),
    Math.min(task.nextRunAt, at.now + 1),
  );
  if (slots.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const ref = (slot: number) => `ns:${row.taskId}:${slot}`;
  const kind = row.checkIn === 1 ? "check_in" : "scheduled";
  const known = new Set(
    (yield* sql<{ ref: string }>`SELECT ref FROM kin_offline_skips
      WHERE org_id = ${orgId} AND kind = ${kind} AND ref IN ${sql.in(slots.map(ref))}
      ORDER BY ref`).map((found) => found.ref),
  );
  const caught = new Set(
    row.checkIn === 1
      ? (yield* sql<{ fireId: string }>`SELECT fire_id AS "fireId" FROM kin_trigger_inbox
          WHERE org_id = ${orgId}
            AND fire_id IN ${sql.in(slots.map((slot) => `${ref(slot)}:scheduled`))}
          ORDER BY fire_id`).map((found) => found.fireId)
      : [],
  );
  const skips: Array<{ ref: string; reason: SkipReason; at: number }> = [];
  for (const slot of slots) {
    if (known.has(ref(slot)) || caught.has(`${ref(slot)}:scheduled`)) continue;
    let reason: SkipReason = "time_passed";
    if (row.checkIn === 1 && slot === KinSchedules.timeOnDayOf(at.now, at.zone, task.timeOfDay)) {
      if (at.firing) continue;
      const closes = slot + CATCH_UP_MS;
      // Still catchable today: skipped only when no hours are left before its window closes.
      if (at.now < closes) {
        let hoursLeft = false;
        for (let t = at.now; t < closes && !hoursLeft; t += STEP_MS)
          hoursLeft = inHoursAt(row, at.owners, t);
        if (hoursLeft) continue;
        reason = "outside_hours";
      }
    }
    skips.push({ ref: ref(slot), reason, at: slot });
  }
  yield* recordSkips(orgId, kind, skips);
});

/**
 * Today's check-ins the host was asleep or down for, as the fire their slot would have made,
 * while the owner is in their hours. The fire's id is the slot's, so it is put once.
 */
export const missedCheckIns = Effect.fn("KinPulse.missedCheckIns")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    taskId: string;
    scheduleId: string;
    timeOfDay: string | null;
    weekdays: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    enabled: number;
    timeZone: string | null;
    workHours: string | null;
    checkIn: number;
    since: number;
  }>`SELECT s.task_id AS "taskId", s.schedule_id AS "scheduleId",
      s.check_in AS "checkIn", s.updated_at AS since,
      json_extract(t.schedule_json, '$.timeOfDay') AS "timeOfDay",
      json_extract(t.schedule_json, '$.weekdays') AS weekdays,
      t.next_run_at AS "nextRunAt", t.last_run_at AS "lastRunAt",
      COALESCE(s.pending_enabled, t.enabled) AS enabled,
      p.time_zone AS "timeZone", p.work_hours_json AS "workHours"
    FROM kin_schedules s
    JOIN scheduled_tasks t ON t.task_id = s.task_id
    JOIN kin_agents a ON a.org_id = s.org_id AND a.agent_id = s.agent_id
    JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
    WHERE s.org_id = ${orgId} AND s.deleted_at IS NULL
      AND json_extract(t.schedule_json, '$.type') = 'fixed_time'
    ORDER BY s.task_id`;
  const zone = KinSchedules.hostTimeZone();
  const owners = yield* ownerZone(orgId);
  const fires: Array<KinTriggerFired> = [];
  for (const row of rows) {
    if (row.enabled !== 1 || row.timeOfDay === null) continue;
    const task = {
      timeOfDay: row.timeOfDay,
      weekdays: row.weekdays === null ? [] : Option.getOrElse(decodeDays(row.weekdays), () => []),
      nextRunAt: row.nextRunAt === null ? null : Date.parse(row.nextRunAt),
      lastRunAt: row.lastRunAt === null ? null : Date.parse(row.lastRunAt),
    };
    const opens = row.checkIn === 1 ? missedSlot(task, now, zone) : undefined;
    const firing = opens !== undefined && inHoursAt(row, owners, now);
    yield* recordPassed(orgId, row, task, { now, zone, owners, firing });
    if (!firing) continue;
    fires.push(
      yield* decodeFire({
        fireId: `ns:${row.taskId}:${opens}:scheduled`,
        orgId,
        dueAt: iso(opens),
        firedAt: iso(now),
        lateByMs: now - opens,
        payload: {
          kind: "time",
          triggerId: `native:${row.scheduleId}`,
          subject: { type: "scheduled_task", itemId: KinMemoryItemId.make(row.scheduleId) },
        },
      }),
    );
  }
  return fires;
});
