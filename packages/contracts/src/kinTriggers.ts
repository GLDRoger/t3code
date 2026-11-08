import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { KinOrgId, KinPersonId, KinText } from "./kinChat.ts";
import { CanonicalUtcTimestamp, KinMemoryItemId } from "./kinLead.ts";
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
  ]),
});
export type KinTriggerFired = typeof KinTriggerFired.Type;

export const KinWebhookSource = Schema.Struct({
  id: KinWebhookSourceId,
  orgId: KinOrgId,
  repo: KinText,
  scheduledTaskId: ScheduledTaskId,
  inboxThreadId: ThreadId,
  githubHookId: Schema.NullOr(Schema.Int),
  botLogin: KinText,
  status: Schema.Literals(["active", "paused_in_t3", "blocked_by_policy", "missing"]),
});
export type KinWebhookSource = typeof KinWebhookSource.Type;

/** `KinWebhookSource.repo` of an org's GitHub App webhook source, which covers every installed repo. */
export const KIN_GITHUB_APP_SOURCE = "github-app";

export const KinGithubWebhookSetupInput = Schema.Struct({ orgId: KinOrgId, projectId: ProjectId });
export type KinGithubWebhookSetupInput = typeof KinGithubWebhookSetupInput.Type;
export const KinGithubWebhookOrgInput = Schema.Struct({ orgId: KinOrgId });
export type KinGithubWebhookOrgInput = typeof KinGithubWebhookOrgInput.Type;
// The message names only length and character class: RpcServer returns it to the client verbatim.
const WebhookSecret = Schema.String.check(
  Schema.makeFilter((value: string) => value.length >= 16 && !/\s/.test(value), {
    message: "A webhook secret needs at least 16 characters and no whitespace.",
  }),
);
export const KinGithubWebhookSecretInput = Schema.Struct({
  orgId: KinOrgId,
  secret: Schema.RedactedFromValue(WebhookSecret),
});
export type KinGithubWebhookSecretInput = typeof KinGithubWebhookSecretInput.Type;

/**
 * `configured`: GitHub and T3 share the secret. `needs_secret`: set this URL and a new secret in
 * the GitHub App's webhook settings, then send the secret. `needs_url`: update only the URL there;
 * a rotate has already retired the old URL, so deliveries fail until GitHub has the new one.
 */
export const KinGithubWebhookSetup = Schema.Union([
  Schema.Struct({ status: Schema.Literal("needs_connect") }),
  Schema.Struct({
    status: Schema.Literals(["configured", "needs_secret", "needs_url"]),
    sourceId: KinWebhookSourceId,
    url: Schema.String,
  }),
]);
export type KinGithubWebhookSetup = typeof KinGithubWebhookSetup.Type;

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
