import { KinMemoryItemId, KinTriggerFired, type KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
  }>`SELECT s.task_id AS "taskId", s.schedule_id AS "scheduleId",
      json_extract(t.schedule_json, '$.timeOfDay') AS "timeOfDay",
      json_extract(t.schedule_json, '$.weekdays') AS weekdays,
      t.next_run_at AS "nextRunAt", t.last_run_at AS "lastRunAt",
      COALESCE(s.pending_enabled, t.enabled) AS enabled,
      p.time_zone AS "timeZone", p.work_hours_json AS "workHours"
    FROM kin_schedules s
    JOIN scheduled_tasks t ON t.task_id = s.task_id
    JOIN kin_agents a ON a.org_id = s.org_id AND a.agent_id = s.agent_id
    JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
    WHERE s.org_id = ${orgId} AND s.check_in = 1 AND s.deleted_at IS NULL
      AND json_extract(t.schedule_json, '$.type') = 'fixed_time'
    ORDER BY s.task_id`;
  const zone = KinSchedules.hostTimeZone();
  const owners = yield* ownerZone(orgId);
  const fires: Array<KinTriggerFired> = [];
  for (const row of rows) {
    if (row.enabled !== 1 || row.timeOfDay === null) continue;
    const opens = missedSlot(
      {
        timeOfDay: row.timeOfDay,
        weekdays: row.weekdays === null ? [] : Option.getOrElse(decodeDays(row.weekdays), () => []),
        nextRunAt: row.nextRunAt === null ? null : Date.parse(row.nextRunAt),
        lastRunAt: row.lastRunAt === null ? null : Date.parse(row.lastRunAt),
      },
      now,
      zone,
    );
    if (opens === undefined || !inHoursAt(row, owners, now)) continue;
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
