import * as Schema from "effect/Schema";

import { NonNegativeInt, ScheduledTaskId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinOrgId, KinPersonId } from "./kinChat.ts";
import { CanonicalUtcTimestamp, GithubRepoSlug, KinMemoryItemId } from "./kinLead.ts";
import { ScheduledTaskUpsertSchedule, ScheduledTaskWebhookDeliveryId } from "./scheduledTask.ts";

import { TimeOfDay, TimeZone } from "./kinTime.ts";

export { canonicalTimeZone } from "./kinTime.ts";

const [interval, fixedTime, once] = ScheduledTaskUpsertSchedule.members;
const Weekday = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));

export const KinTriggerFireId = TrimmedNonEmptyString.pipe(Schema.brand("KinTriggerFireId"));
export type KinTriggerFireId = typeof KinTriggerFireId.Type;
export const KinWebhookSourceId = TrimmedNonEmptyString.pipe(Schema.brand("KinWebhookSourceId"));
export type KinWebhookSourceId = typeof KinWebhookSourceId.Type;

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

export const KinTriggerSchedule = Schema.Union([interval, fixedTime, once]);
export type KinTriggerSchedule = typeof KinTriggerSchedule.Type;

export const KinTriggerSubject = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("deferral"),
    itemId: KinMemoryItemId,
    phase: Schema.Literals(["heads_up", "due"]),
  }),
  Schema.Struct({ type: Schema.Literal("reminder"), itemId: KinMemoryItemId }),
  Schema.Struct({
    type: Schema.Literal("followup"),
    itemId: KinMemoryItemId,
    person: KinPersonId,
  }),
  Schema.Struct({ type: Schema.Literal("routine"), routine: KinRoutine }),
  Schema.Struct({ type: Schema.Literal("watchdog"), watchdog: KinWatchdog }),
  Schema.Struct({ type: Schema.Literal("scheduled_task"), itemId: KinMemoryItemId }),
]);
export type KinTriggerSubject = typeof KinTriggerSubject.Type;

export const KinTrigger = Schema.Struct({
  id: KinTriggerId,
  orgId: KinOrgId,
  subject: KinTriggerSubject,
  schedule: KinTriggerSchedule,
  timeZone: TimeZone,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.toEncoded(CanonicalUtcTimestamp)),
  lastFireId: Schema.NullOr(KinTriggerFireId),
  createdAt: Schema.toEncoded(CanonicalUtcTimestamp),
  updatedAt: Schema.toEncoded(CanonicalUtcTimestamp),
});
export type KinTrigger = typeof KinTrigger.Type;

export const KinTriggerFired = Schema.Struct({
  fireId: KinTriggerFireId,
  orgId: KinOrgId,
  dueAt: Schema.toEncoded(CanonicalUtcTimestamp),
  firedAt: Schema.toEncoded(CanonicalUtcTimestamp),
  lateByMs: NonNegativeInt,
  payload: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("time"),
      triggerId: KinTriggerId,
      subject: KinTriggerSubject,
    }),
    Schema.Struct({
      kind: Schema.Literal("github"),
      sourceId: KinWebhookSourceId,
      scheduledTaskId: ScheduledTaskId,
      deliveryId: ScheduledTaskWebhookDeliveryId,
    }),
    /** TRIG-6 asks TRIG-10's sweep to re-read GitHub; `repo: null` means every scoped repo. */
    Schema.Struct({
      kind: Schema.Literal("github_recheck"),
      repo: Schema.NullOr(GithubRepoSlug),
      reason: Schema.Literals(["delivery_missing", "body_unparseable", "repo_unknown", "stale"]),
      sourceFireId: KinTriggerFireId,
    }),
  ]),
});
export type KinTriggerFired = typeof KinTriggerFired.Type;

export const KinGithubEvent = Schema.Struct({
  orgId: KinOrgId,
  deliveryId: TrimmedNonEmptyString,
  event: Schema.String,
  action: Schema.NullOr(Schema.String),
  repo: Schema.String,
  number: Schema.NullOr(Schema.Int),
  headSha: Schema.NullOr(Schema.String),
  sender: Schema.String,
  receivedAt: Schema.toEncoded(CanonicalUtcTimestamp),
  heldByRelay: Schema.Boolean,
  bodyTruncated: Schema.Boolean,
  payload: Schema.Unknown,
});
export type KinGithubEvent = typeof KinGithubEvent.Type;

export const KinTriggerSettings = Schema.Struct({
  orgId: KinOrgId,
  timeZone: TimeZone,
  morningBrief: TimeOfDay,
  eveningSummary: TimeOfDay,
  dream: TimeOfDay,
  fullRebuildWeekday: Weekday,
  ownerCheckWeekday: Weekday,
  ownerCheck: TimeOfDay,
  quietHours: Schema.Struct({ from: TimeOfDay, to: TimeOfDay }),
});
export type KinTriggerSettings = typeof KinTriggerSettings.Type;

export const KinOwnerTimeZoneGetInput = Schema.Struct({ orgId: KinOrgId });
export type KinOwnerTimeZoneGetInput = typeof KinOwnerTimeZoneGetInput.Type;
export const KinOwnerTimeZone = Schema.Struct({ orgId: KinOrgId, timeZone: TimeZone });
export type KinOwnerTimeZone = typeof KinOwnerTimeZone.Type;
/** The zone Kin uses; `fromHost` while the owner has set none and the host's stands in. */
export const KinOwnerTimeZoneRead = Schema.Struct({
  ...KinOwnerTimeZone.fields,
  fromHost: Schema.optionalKey(Schema.Literal(true)),
});
export type KinOwnerTimeZoneRead = typeof KinOwnerTimeZoneRead.Type;
