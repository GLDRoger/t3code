import {
  KIN_SCHEDULED_TASK_CARD_ACTIONS,
  KinChatError,
  KinScheduledTaskCard,
  type KinScheduledTaskCardAction,
  KinTriggerId,
  type KinTriggerSchedule,
  type KinOrgId,
  type KinWidget,
  type MemoryItemEvery,
  kinScheduledTaskWidgetId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import { type KinSchedule, readNativeTask, readSchedule } from "../triggers/kinSchedules.ts";

export const scheduledTaskTriggerId = (itemId: string) => KinTriggerId.make(`schedule:${itemId}`);

export const scheduleOf = (every: MemoryItemEvery): KinTriggerSchedule => ({
  type: "fixed_time",
  timeOfDay: every.at,
  weekdays: [...new Set(every.days)].toSorted((a, b) => a - b),
});

/** The next run strictly after `now`, read in the owner's zone. */
export const nextRun = (every: MemoryItemEvery, now: number, timeZone: string) => {
  const next = nextScheduledRunAt(scheduleOf(every), DateTime.makeZonedUnsafe(now, { timeZone }));
  return next === null ? null : DateTime.toEpochMillis(next);
};

export interface ScheduledTaskRow {
  readonly state: "active" | "deleted" | "disarmed";
  readonly paused: number;
  readonly recordedAt: string;
  readonly chatId: string | null;
  readonly runNowAt: number | null;
}
export const readScheduledTask = (sql: SqlClient.SqlClient, orgId: KinOrgId, itemId: string) =>
  sql<ScheduledTaskRow>`SELECT state, paused, recorded_at AS "recordedAt", chat_id AS "chatId",
      run_now_at AS "runNowAt"
    FROM kin_scheduled_tasks WHERE org_id = ${orgId} AND item_id = ${itemId} ORDER BY item_id`.pipe(
    Effect.map((rows) => rows[0]),
  );

const decodeCard = Schema.decodeUnknownEffect(KinScheduledTaskCard);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

const isScheduledTaskAction = (actionId: string): actionId is KinScheduledTaskCardAction =>
  KIN_SCHEDULED_TASK_CARD_ACTIONS.some((action) => action === actionId);

/** What a tap on a scheduled task card says; only Edit and Delete need the lead. */
export const describeScheduledTaskTap = Effect.fn("KinScheduledTasks.describeTap")(function* (
  widget: KinWidget,
  actionId: string,
  value: unknown,
) {
  const card = yield* decodeCard(widget.state).pipe(
    Effect.mapError(() => invalid("Invalid widget state.")),
  );
  if (
    !isScheduledTaskAction(actionId) ||
    card.itemId !== value ||
    widget.widgetId !== kinScheduledTaskWidgetId(widget.orgId, card.itemId)
  )
    return yield* invalid("Unknown card action.");
  const sql = yield* SqlClient.SqlClient;
  // A native schedule's Delete is the server's to finish; the old kind asks its lead to cancel it.
  const native = (yield* readSchedule(sql, widget.orgId, card.itemId)) !== undefined;
  return {
    card,
    action: actionId,
    text: `Tapped "${LABELS[actionId]}" on the scheduled task "${card.title}"`,
    wake: actionId === "edit" || (actionId === "delete" && !native),
  };
});

/**
 * Applies a described tap in the tap's transaction: Run now queues a run for the next tick,
 * Pause and Resume switch the trigger, Delete disarms it. Returns the card's next state, or null.
 */
export const applyScheduledTaskTap = Effect.fn("KinScheduledTasks.applyTap")(function* (
  widget: KinWidget,
  tap: Effect.Success<ReturnType<typeof describeScheduledTaskTap>>,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = widget.orgId;
  const { card, action } = tap;
  if (action === "edit") return null;
  const schedule = yield* readSchedule(sql, orgId, card.itemId);
  if (schedule !== undefined) return yield* applyNativeTap(sql, schedule, card, action, now);
  const row = yield* readScheduledTask(sql, orgId, card.itemId);
  if (row === undefined || row.state !== "active")
    return yield* invalid("This scheduled task was deleted.");
  const triggerId = scheduledTaskTriggerId(card.itemId);
  switch (action) {
    case "run_now": {
      if (row.runNowAt !== null || card.lastRun?.status === "running")
        return yield* invalid("It's already running.");
      yield* sql`UPDATE kin_scheduled_tasks SET run_now_at = ${now}, updated_at = ${now}
        WHERE org_id = ${orgId} AND item_id = ${card.itemId} AND run_now_at IS NULL`;
      return {
        state: { ...card, lastRun: { at: iso(now), status: "running" } },
        closed: false,
      } satisfies { state: KinScheduledTaskCard; closed: boolean };
    }
    case "pause": {
      if (row.paused === 1) return yield* invalid("It's already paused.");
      yield* sql`UPDATE kin_scheduled_tasks SET paused = 1, updated_at = ${now}
        WHERE org_id = ${orgId} AND item_id = ${card.itemId}`;
      yield* sql`UPDATE kin_triggers SET enabled = 0, next_run_at = NULL,
          updated_at = max(updated_at, ${now}) WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
      return { state: { ...card, status: "paused", nextRunAt: null }, closed: false } satisfies {
        state: KinScheduledTaskCard;
        closed: boolean;
      };
    }
    case "resume": {
      if (row.paused === 0) return yield* invalid("It's already running on schedule.");
      const next = nextRun(card.every, now, card.timeZone);
      yield* sql`UPDATE kin_scheduled_tasks SET paused = 0, updated_at = ${now}
        WHERE org_id = ${orgId} AND item_id = ${card.itemId}`;
      yield* sql`UPDATE kin_triggers SET enabled = 1, next_run_at = ${next},
          updated_at = max(updated_at, ${now}) WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
      return {
        state: { ...card, status: "active", nextRunAt: next === null ? null : iso(next) },
        closed: false,
      } satisfies { state: KinScheduledTaskCard; closed: boolean };
    }
    case "delete": {
      yield* sql`UPDATE kin_scheduled_tasks SET state = 'deleted', run_now_at = NULL,
          updated_at = ${now} WHERE org_id = ${orgId} AND item_id = ${card.itemId}`;
      yield* sql`UPDATE kin_triggers SET enabled = 0, next_run_at = NULL,
          updated_at = max(updated_at, ${now}) WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
      return { state: { ...card, status: "deleted", nextRunAt: null }, closed: true } satisfies {
        state: KinScheduledTaskCard;
        closed: boolean;
      };
    }
  }
});

/** A native schedule's tap is recorded here; the next tick applies it to the native task. */
const applyNativeTap = Effect.fn("KinScheduledTasks.applyNativeTap")(function* (
  sql: SqlClient.SqlClient,
  schedule: KinSchedule,
  card: KinScheduledTaskCard,
  action: Exclude<KinScheduledTaskCardAction, "edit">,
  now: number,
) {
  const task = yield* readNativeTask(sql, schedule.taskId);
  if (task === undefined || schedule.deletedAt !== null)
    return yield* invalid("This scheduled task was deleted.");
  const enabled =
    schedule.pendingEnabled === null ? task.enabled === 1 : schedule.pendingEnabled === 1;
  const where = sql`task_id = ${schedule.taskId}`;
  switch (action) {
    case "run_now": {
      if (schedule.runNowAt !== null || card.lastRun?.status === "running")
        return yield* invalid("It's already running.");
      yield* sql`UPDATE kin_schedules SET run_now_at = ${now}, updated_at = ${now} WHERE ${where}`;
      return {
        state: { ...card, lastRun: { at: iso(now), status: "running" } },
        closed: false,
      } satisfies { state: KinScheduledTaskCard; closed: boolean };
    }
    case "pause": {
      if (!enabled) return yield* invalid("It's already paused.");
      yield* sql`UPDATE kin_schedules SET pending_enabled = 0, updated_at = ${now} WHERE ${where}`;
      return {
        state: { ...card, status: "paused", nextRunAt: null },
        closed: false,
      } satisfies { state: KinScheduledTaskCard; closed: boolean };
    }
    case "resume": {
      if (enabled) return yield* invalid("It's already running on schedule.");
      yield* sql`UPDATE kin_schedules SET pending_enabled = 1, updated_at = ${now} WHERE ${where}`;
      const next = nextRun(card.every, now, card.timeZone);
      return {
        state: { ...card, status: "active", nextRunAt: next === null ? null : iso(next) },
        closed: false,
      } satisfies { state: KinScheduledTaskCard; closed: boolean };
    }
    case "delete": {
      yield* sql`UPDATE kin_schedules SET deleted_at = ${now}, updated_at = ${now} WHERE ${where}`;
      return {
        state: { ...card, status: "deleted", nextRunAt: null },
        closed: true,
      } satisfies { state: KinScheduledTaskCard; closed: boolean };
    }
  }
});

const LABELS: Record<KinScheduledTaskCardAction, string> = {
  run_now: "Run now",
  pause: "Pause",
  resume: "Resume",
  edit: "Edit",
  delete: "Delete",
};
