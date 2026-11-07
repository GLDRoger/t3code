import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { KinOrgId, KinPersonId } from "./kinChat.ts";
import { MIN_SCHEDULED_TASK_INTERVAL_MS, ScheduledTaskWebhookDeliveryId } from "./scheduledTask.ts";

const TimeOfDay = TrimmedNonEmptyString.check(Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/));
const Weekday = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));

export const KinTriggerId = TrimmedNonEmptyString.pipe(Schema.brand("KinTriggerId"));
export type KinTriggerId = typeof KinTriggerId.Type;

export const KinRoutine = Schema.Literals([
  "morning_brief",
  "evening_summary",
  "dream",
  "dream_full",
  "owner_check",
]);
export type KinRoutine = typeof KinRoutine.Type;

export const KinWatchdog = Schema.Literals([
  "github_recheck",
  "stale_review",
  "promise_overdue",
  "objective_at_risk",
  "index_freshness",
  "trigger_reconcile",
]);
export type KinWatchdog = typeof KinWatchdog.Type;

export const KinTriggerSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), runAt: IsoDateTime }),
  Schema.Struct({
    type: Schema.Literal("fixed_time"),
    timeOfDay: TimeOfDay,
    weekdays: Schema.optional(Schema.Array(Weekday)),
  }),
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS)),
  }),
]);
export type KinTriggerSchedule = typeof KinTriggerSchedule.Type;

export const KinTriggerSubject = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("deferral"),
    itemId: Schema.String,
    phase: Schema.Literals(["heads_up", "due"]),
  }),
  Schema.Struct({ type: Schema.Literal("reminder"), itemId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("followup"), itemId: Schema.String, person: KinPersonId }),
  Schema.Struct({ type: Schema.Literal("routine"), routine: KinRoutine }),
  Schema.Struct({ type: Schema.Literal("watchdog"), watchdog: KinWatchdog }),
]);
export type KinTriggerSubject = typeof KinTriggerSubject.Type;

export const KinTrigger = Schema.Struct({
  id: KinTriggerId,
  orgId: KinOrgId,
  subject: KinTriggerSubject,
  schedule: KinTriggerSchedule,
  timeZone: Schema.String,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastFireId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type KinTrigger = typeof KinTrigger.Type;

export const KinTriggerFired = Schema.Struct({
  fireId: Schema.String,
  orgId: KinOrgId,
  dueAt: IsoDateTime,
  firedAt: IsoDateTime,
  lateByMs: NonNegativeInt,
  payload: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("time"),
      triggerId: KinTriggerId,
      subject: KinTriggerSubject,
    }),
    Schema.Struct({
      kind: Schema.Literal("github"),
      sourceId: Schema.String,
      scheduledTaskId: ScheduledTaskId,
      deliveryId: ScheduledTaskWebhookDeliveryId,
    }),
  ]),
});
export type KinTriggerFired = typeof KinTriggerFired.Type;

export const KinWebhookSource = Schema.Struct({
  id: Schema.String,
  orgId: KinOrgId,
  repo: Schema.String,
  scheduledTaskId: ScheduledTaskId,
  inboxThreadId: ThreadId,
  githubHookId: Schema.NullOr(Schema.Int),
  botLogin: Schema.String,
  status: Schema.Literals(["active", "paused_in_t3", "blocked_by_policy", "missing"]),
});
export type KinWebhookSource = typeof KinWebhookSource.Type;

export const KinGithubEvent = Schema.Struct({
  orgId: KinOrgId,
  deliveryId: Schema.String,
  event: Schema.String,
  action: Schema.NullOr(Schema.String),
  repo: Schema.String,
  number: Schema.NullOr(Schema.Int),
  headSha: Schema.NullOr(Schema.String),
  sender: Schema.String,
  receivedAt: IsoDateTime,
  heldByRelay: Schema.Boolean,
  bodyTruncated: Schema.Boolean,
  payload: Schema.Unknown,
});
export type KinGithubEvent = typeof KinGithubEvent.Type;

export const KinTriggerSettings = Schema.Struct({
  orgId: KinOrgId,
  timeZone: Schema.String,
  morningBrief: TimeOfDay,
  eveningSummary: TimeOfDay,
  dream: TimeOfDay,
  fullRebuildWeekday: Weekday,
  ownerCheckWeekday: Weekday,
  ownerCheck: TimeOfDay,
  quietHours: Schema.Struct({ from: TimeOfDay, to: TimeOfDay }),
});
export type KinTriggerSettings = typeof KinTriggerSettings.Type;
