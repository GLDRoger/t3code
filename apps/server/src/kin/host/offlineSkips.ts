import type { KinOrgId, ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import { DAY_MS } from "../durations.ts";

/** How far back a skip is kept; anything that far back is no downtime's news any more. */
export const SKIP_KEEP_DAYS = 30;
export const SKIP_KEEP_MS = SKIP_KEEP_DAYS * DAY_MS;

export type SkipKind = "message" | "scheduled" | "check_in";
export type SkipReason = "older_than_a_day" | "over_the_count" | "time_passed" | "outside_hours";

/** Records what Kin passed over; the same thing (kind and ref) is kept once. */
export const recordSkips = Effect.fn("KinOfflineSkips.record")(function* (
  orgId: KinOrgId,
  kind: SkipKind,
  skips: ReadonlyArray<{ readonly ref: string; readonly reason: SkipReason; readonly at: number }>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const { ref, reason, at } of skips)
    yield* sql`INSERT INTO kin_offline_skips (org_id, kind, ref, reason, at)
      VALUES (${orgId}, ${kind}, ${ref}, ${reason}, ${at})
      ON CONFLICT (org_id, kind, ref) DO NOTHING`;
});

/** A schedule's slots strictly between `after` and `before`, never reaching back past the keep. */
export const slotsBetween = (
  schedule: ScheduledTaskSchedule,
  timeZone: string,
  after: number,
  before: number,
) => {
  const slots: Array<number> = [];
  let at = Math.max(after, before - SKIP_KEEP_MS);
  while (true) {
    const next = nextScheduledRunAt(schedule, DateTime.makeZonedUnsafe(at, { timeZone }));
    if (next === null || DateTime.toEpochMillis(next) >= before) return slots;
    at = DateTime.toEpochMillis(next);
    slots.push(at);
  }
};
