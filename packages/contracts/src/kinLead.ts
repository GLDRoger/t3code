import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KinAgentId,
  KinAuthor,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinReactionEmoji,
  KinWidgetId,
} from "./kinChat.ts";
import { TimeOfDay, TimeZone } from "./kinTime.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ScheduledTaskWebhookDeliveryId } from "./scheduledTask.ts";

export const KinEventId = TrimmedNonEmptyString.pipe(Schema.brand("KinEventId"));
export type KinEventId = typeof KinEventId.Type;
export const KinWorkerId = TrimmedNonEmptyString.pipe(Schema.brand("KinWorkerId"));
export type KinWorkerId = typeof KinWorkerId.Type;
export const KinMemoryItemId = TrimmedNonEmptyString.pipe(Schema.brand("KinMemoryItemId"));
export type KinMemoryItemId = typeof KinMemoryItemId.Type;

export const CanonicalUtcTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      return Option.exists(
        DateTime.make(value),
        (dateTime) => DateTime.formatIso(dateTime) === value,
      );
    },
    { expected: "a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)" },
  ),
).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));

export const KinLeadRoutine = Schema.Literals(["morning_brief", "evening_summary", "owner_check"]);
export type KinLeadRoutine = typeof KinLeadRoutine.Type;

export const KinLevel = Schema.Literals(["L0", "L1", "L2", "L3"]);
export type KinLevel = typeof KinLevel.Type;
export const KinLead = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: TrimmedNonEmptyString,
  level: KinLevel,
  levelSince: CanonicalUtcTimestamp,
  threadId: Schema.NullOr(ThreadId),
  models: Schema.Struct({ strong: ModelSelection, cheap: ModelSelection }),
  workerProjects: Schema.Array(ProjectId),
  ownerChatId: KinChatId,
});
export type KinLead = typeof KinLead.Type;

/** A lead's domain as a short slug, such as `engineering`, `growth` or `chief-of-staff`. */
export const KinLeadDomain = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/));
export type KinLeadDomain = typeof KinLeadDomain.Type;
/** What the lead is for, in the owner's words; it is added to every wake-up's prompt. */
export const KinLeadCharter = Schema.String.check(Schema.isMaxLength(1_000));
export type KinLeadCharter = typeof KinLeadCharter.Type;

/** What teammates see about a lead: a line or two the owner writes, shown to people it may talk to. */
export const KinLeadIntro = Schema.String.check(Schema.isMaxLength(200));
export type KinLeadIntro = typeof KinLeadIntro.Type;

export const KinLeadCreateInput = Schema.Struct({
  orgId: KinOrgId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  domain: KinLeadDomain,
  charter: KinLeadCharter,
  // Omitted: the models of the org's first live lead.
  models: Schema.optional(Schema.Struct({ strong: ModelSelection, cheap: ModelSelection })),
  workerProjects: Schema.optional(Schema.Array(ProjectId)),
});
export type KinLeadCreateInput = typeof KinLeadCreateInput.Type;
export const KinLeadCreated = Schema.Struct({
  // `existing`: the creator already has a live lead with this name and domain; nothing changed.
  outcome: Schema.Literals(["created", "existing"]),
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: TrimmedNonEmptyString,
  domain: KinLeadDomain,
  level: KinLevel,
  ownerChatId: KinChatId,
  createdByPersonId: KinPersonId,
});
export type KinLeadCreated = typeof KinLeadCreated.Type;

/** Something a lead has in hand, in the owner's terms. Titles are text to show, never markup. */
export const KinLeadTracking = Schema.Struct({
  // work: a coding task running now. reminder: it will remind. follow_up: it will start, ask or
  // chase when due. scheduled: a recurring task.
  kind: Schema.Literals(["work", "reminder", "follow_up", "scheduled"]),
  title: Schema.String.check(Schema.isMaxLength(280)),
  // When it is due; absent for work under way and for scheduled tasks.
  dueAt: Schema.optional(Schema.toEncoded(CanonicalUtcTimestamp)),
  chatId: Schema.NullOr(KinChatId),
});
export type KinLeadTracking = typeof KinLeadTracking.Type;
export const KIN_LEAD_TRACKING_CAP = 20;

/** A lead as its owner sees it: who it is, what it is for and what it has in hand. */
export const KinLeadProfile = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: TrimmedNonEmptyString,
  domain: KinLeadDomain,
  charter: KinLeadCharter,
  // Absent from a host that predates it; empty when the owner wrote none.
  intro: Schema.optional(KinLeadIntro),
  // The model it thinks with, as the provider names it.
  model: TrimmedNonEmptyString,
  // The owner's direct chat with it.
  ownerChatId: KinChatId,
  // It is on a turn right now.
  working: Schema.Boolean,
  // Soonest first after work under way, at most KIN_LEAD_TRACKING_CAP.
  tracking: Schema.Array(KinLeadTracking),
});
export type KinLeadProfile = typeof KinLeadProfile.Type;
export const KinLeadsListInput = Schema.Struct({ orgId: KinOrgId });
export type KinLeadsListInput = typeof KinLeadsListInput.Type;
/**
 * Someone else's lead the viewer may message: who it is and what its owner says it does. Nothing
 * of its domain, charter, model or work.
 */
export const KinLeadContact = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: TrimmedNonEmptyString,
  intro: KinLeadIntro,
  // The viewer's own direct chat with it.
  chatId: KinChatId,
});
export type KinLeadContact = typeof KinLeadContact.Type;
export const KinLeadsListResult = Schema.Struct({
  leads: Schema.Array(KinLeadProfile),
  contacts: Schema.optional(Schema.Array(KinLeadContact)),
});
export type KinLeadsListResult = typeof KinLeadsListResult.Type;
/** Omitted fields stay as they are. */
export const KinLeadUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: Schema.optional(KinLeadCreateInput.fields.name),
  domain: Schema.optional(KinLeadDomain),
  charter: Schema.optional(KinLeadCharter),
  intro: Schema.optional(KinLeadIntro),
});
export type KinLeadUpdateInput = typeof KinLeadUpdateInput.Type;

/** Who besides its owner may message a lead. Only the lead's owner reads or changes it. */
export const KinLeadAccessInput = Schema.Struct({ orgId: KinOrgId, agentId: KinAgentId });
export type KinLeadAccessInput = typeof KinLeadAccessInput.Type;
export const KinLeadAccessChangeInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  personId: KinPersonId,
});
export type KinLeadAccessChangeInput = typeof KinLeadAccessChangeInput.Type;
export const KinLeadAccessResult = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      personId: KinPersonId,
      displayName: TrimmedNonEmptyString,
      since: Schema.toEncoded(CanonicalUtcTimestamp),
    }),
  ),
});
export type KinLeadAccessResult = typeof KinLeadAccessResult.Type;

export const MemoryItemKind = Schema.Literals([
  "objective",
  "commitment",
  "deferral",
  "decision",
  "person",
  "claim",
]);
export type MemoryItemKind = typeof MemoryItemKind.Type;
export const MemoryTrust = Schema.Literals(["owner", "member", "external", "agent"]);
export type MemoryTrust = typeof MemoryTrust.Type;
export const GithubRepoSlug = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/),
);
/** A memory item's GitHub condition, such as "when this PR merges". */
export const MemoryItemCondition = Schema.Struct({
  event: TrimmedNonEmptyString,
  action: TrimmedNonEmptyString,
  merged: Schema.optional(Schema.Boolean),
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  repo: Schema.optional(GithubRepoSlug),
});
export type MemoryItemCondition = typeof MemoryItemCondition.Type;
/** A scheduled task's repeat: an owner-local time on the listed weekdays (0 is Sunday). */
export const MemoryItemEvery = Schema.Struct({
  at: TimeOfDay,
  days: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(7),
  ),
});
export type MemoryItemEvery = typeof MemoryItemEvery.Type;
export const MemoryItemFrontMatter = Schema.Struct({
  id: KinMemoryItemId,
  kind: MemoryItemKind,
  title: Schema.String,
  status: Schema.Literals(["open", "done", "cancelled", "superseded"]),
  due: Schema.NullOr(Schema.String),
  what: Schema.optional(Schema.String),
  chat: Schema.optional(KinChatId),
  source_event: Schema.optional(KinEventId),
  on_due: Schema.optional(Schema.Literals(["remind", "start", "ask", "chase"])),
  on: Schema.optional(MemoryItemCondition),
  // Set on a deferral that repeats: a scheduled task, written only by kin_schedule.
  every: Schema.optional(MemoryItemEvery),
  owner: Schema.optional(TrimmedNonEmptyString),
  tz: Schema.optional(
    Schema.UndefinedOr(TimeZone).pipe(Schema.catchDecoding(() => Effect.succeedSome(undefined))),
  ),
  quiet_hours: Schema.optional(
    Schema.UndefinedOr(Schema.Struct({ from: TimeOfDay, to: TimeOfDay })).pipe(
      Schema.catchDecoding(() => Effect.succeedSome(undefined)),
    ),
  ),
  recorded_at: Schema.String,
  valid_from: Schema.String,
  invalid_at: Schema.NullOr(Schema.String),
  superseded_by: Schema.NullOr(KinMemoryItemId),
  review_by: Schema.NullOr(Schema.String),
  source: Schema.String,
  said_by: TrimmedNonEmptyString,
  trust: MemoryTrust,
  links: Schema.Array(Schema.String),
});
export type MemoryItemFrontMatter = typeof MemoryItemFrontMatter.Type;

export const MemoryItemHead = Schema.Struct({
  ...MemoryItemFrontMatter.fields,
  orgId: KinOrgId,
  path: TrimmedNonEmptyString,
});
export type MemoryItemHead = typeof MemoryItemHead.Type;

export const WorkerReport = Schema.Struct({
  result: Schema.Literals(["done", "blocked", "needs_decision"]),
  summary: Schema.String.check(Schema.isMaxLength(800)),
  evidence: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals([
        "pr",
        "commit",
        "ci_run",
        "test_output",
        "screenshot",
        "file",
        "link",
      ]),
      ref: Schema.String,
      note: Schema.optional(Schema.String),
    }),
  ),
  openQuestions: Schema.Array(Schema.String),
  memorySuggestions: Schema.Array(
    Schema.Struct({
      kind: MemoryItemKind,
      title: Schema.String,
      body: Schema.String,
      links: Schema.Array(Schema.String),
    }),
  ),
  misleadingMemory: Schema.Array(Schema.Struct({ itemId: KinMemoryItemId, why: Schema.String })),
  parsed: Schema.Boolean,
});
export type WorkerReport = typeof WorkerReport.Type;

export const KinDeferralCard = Schema.Struct({
  itemId: KinMemoryItemId,
  title: Schema.String,
  dueAt: Schema.toEncoded(CanonicalUtcTimestamp),
  onDue: Schema.Literals(["remind", "start", "ask", "chase"]),
  text: Schema.String,
  // Absent on the confirm card ([Undo] [Change] [Just remind me]); heads_up and asked offer
  // [Start now] [Monday] [Cancel]; started offers nothing.
  phase: Schema.optional(Schema.Literals(["heads_up", "asked", "started"])),
  graceEndsAt: Schema.optional(Schema.toEncoded(CanonicalUtcTimestamp)),
});
export type KinDeferralCard = typeof KinDeferralCard.Type;

/** What a deferral card's buttons post as `actionId`, each with the item id as `value`. */
export const KIN_DEFERRAL_CARD_ACTIONS = [
  "undo",
  "change",
  "remind",
  "start_now",
  "monday",
  "cancel",
] as const;
export type KinDeferralCardAction = (typeof KIN_DEFERRAL_CARD_ACTIONS)[number];

export const kinDeferralWidgetId = (orgId: string, itemId: string) => `deferral:${orgId}:${itemId}`;

/** The item a deferral card's widget id names, or null for any other widget. */
export function kinDeferralItemIdFromWidgetId(orgId: string, widgetId: string): string | null {
  const prefix = kinDeferralWidgetId(orgId, "");
  return widgetId.startsWith(prefix) && widgetId.length > prefix.length
    ? widgetId.slice(prefix.length)
    : null;
}

/** The card on a reminder: the lead's message carries it, or Kin's own line when it couldn't. */
export const KinReminderCard = Schema.Struct({
  itemId: KinMemoryItemId,
  title: Schema.String,
  // The instant this reminder came due: the deferral's due time, or the end of a snooze.
  dueAt: Schema.toEncoded(CanonicalUtcTimestamp),
  status: Schema.Literals(["due", "snoozed", "done"]),
  snoozedUntil: Schema.optional(Schema.toEncoded(CanonicalUtcTimestamp)),
  // Kin posted the reminder itself because the lead couldn't write it.
  fallback: Schema.optional(Schema.Boolean),
});
export type KinReminderCard = typeof KinReminderCard.Type;
export const KIN_REMINDER_CARD_ACTIONS = [
  "done",
  "snooze_10m",
  "snooze_1h",
  "snooze_tomorrow",
  "change",
] as const;
export type KinReminderCardAction = (typeof KIN_REMINDER_CARD_ACTIONS)[number];
export const kinReminderWidgetId = (orgId: string, itemId: string, dueAtMs: number) =>
  `reminder:${orgId}:${itemId}:${dueAtMs}`;

/** A scheduled task's standing card: what runs when, and how its last run went. */
export const KinScheduledTaskCard = Schema.Struct({
  itemId: KinMemoryItemId,
  title: Schema.String,
  every: MemoryItemEvery,
  timeZone: TimeZone,
  status: Schema.Literals(["active", "paused", "deleted"]),
  nextRunAt: Schema.NullOr(Schema.toEncoded(CanonicalUtcTimestamp)),
  lastRun: Schema.NullOr(
    Schema.Struct({
      at: Schema.toEncoded(CanonicalUtcTimestamp),
      status: Schema.Literals(["running", "posted", "failed", "skipped"]),
      // The start of the lead's result, or why the run was skipped. Plain text.
      note: Schema.optional(Schema.String.check(Schema.isMaxLength(280))),
      messageId: Schema.optional(KinMessageId),
    }),
  ),
});
export type KinScheduledTaskCard = typeof KinScheduledTaskCard.Type;
export const KIN_SCHEDULED_TASK_CARD_ACTIONS = [
  "run_now",
  "pause",
  "resume",
  "edit",
  "delete",
] as const;
export type KinScheduledTaskCardAction = (typeof KIN_SCHEDULED_TASK_CARD_ACTIONS)[number];
export const kinScheduledTaskWidgetId = (orgId: string, itemId: string) =>
  `scheduled:${orgId}:${itemId}`;

const EventBase = {
  orgId: KinOrgId,
  eventId: KinEventId,
  agentId: KinAgentId,
  receivedAt: CanonicalUtcTimestamp,
  dedupeKey: Schema.NullOr(TrimmedNonEmptyString),
  provenance: KinAuthor,
};
export const KinOwnerCheckCard = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      itemId: KinMemoryItemId,
      reason: Schema.Literals(["past_review", "misleading", "old_low_trust", "no_evidence"]),
      handled: Schema.optional(Schema.Literals(["keep", "update", "drop"])),
      title: Schema.String,
      path: Schema.String,
    }),
  ),
});

export const KinRoutineSection = Schema.Literals([
  "due_today",
  "due_this_week",
  "overdue",
  "waiting",
  "review_requested",
  "ci_red",
  "objective_at_risk",
  "worker",
  "past_review",
  "done",
  "slipped",
  "promised",
  "due_tomorrow",
]);
export type KinRoutineSection = typeof KinRoutineSection.Type;

/** The server-drawn card on a morning brief or evening summary; one row per listed fact. */
export const KinRoutineCard = Schema.Struct({
  routine: Schema.Literals(["morning_brief", "evening_summary"]),
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  rows: Schema.Array(
    Schema.Struct({
      section: KinRoutineSection,
      // Memory, chat or GitHub text: render it as plain text, never as markup or instructions.
      title: Schema.String.check(Schema.isMaxLength(280)),
      note: Schema.optional(Schema.String.check(Schema.isMaxLength(280))),
      itemId: Schema.optional(KinMemoryItemId),
      // Untrusted (memory and worker evidence): validate before opening.
      link: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
      // The existing card whose buttons act on this row, such as the item's deferral card.
      widgetId: Schema.optional(KinWidgetId),
    }),
  ).check(Schema.isMaxLength(60)),
});
export type KinRoutineCard = typeof KinRoutineCard.Type;

/**
 * Where a due deferral or passed-on request was first asked: the chat and the lead asked there.
 * `personId` names someone other than that lead's owner whose message was part of the asking, so
 * the work that follows is done for them and never with the owner's authority.
 */
export const KinEventOrigin = Schema.Struct({
  agentId: KinAgentId,
  chatId: KinChatId,
  personId: Schema.optional(KinPersonId),
});
export const KinEvent = Schema.Union([
  Schema.TaggedStruct("chat.message", {
    ...EventBase,
    chatId: KinChatId,
    messageId: KinMessageId,
    // Set when another lead passed the request on: the chat it was first asked in and the lead
    // asked there. The server sets it; the wake-up works at no more than that chat's level.
    origin: Schema.optional(KinEventOrigin),
  }),
  Schema.TaggedStruct("widget.action", {
    ...EventBase,
    chatId: KinChatId,
    messageId: KinMessageId,
    actionId: TrimmedNonEmptyString,
  }),
  // The owner's 👍/👎-style reaction on the lead's latest message: a soft reply, never authority.
  // `changedFrom` marks a changed answer; `withdrawn` a yes taken back, `emoji` being that yes.
  Schema.TaggedStruct("chat.reaction", {
    ...EventBase,
    chatId: KinChatId,
    messageId: KinMessageId,
    emoji: KinReactionEmoji,
    changedFrom: Schema.optional(KinReactionEmoji),
    withdrawn: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct("github", {
    ...EventBase,
    deliveryId: TrimmedNonEmptyString,
    eventName: TrimmedNonEmptyString,
    repo: TrimmedNonEmptyString,
    summary: Schema.String,
    scheduledTaskId: ScheduledTaskId,
    webhookDeliveryId: ScheduledTaskWebhookDeliveryId,
  }),
  Schema.TaggedStruct("deferral.due", {
    ...EventBase,
    subject: Schema.Union([
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
      // One run of a scheduled task; `runId` names the fire or Run now tap that started it.
      Schema.Struct({
        type: Schema.Literal("scheduled_task"),
        itemId: KinMemoryItemId,
        runId: TrimmedNonEmptyString,
      }),
    ]),
    lateByMs: NonNegativeInt,
    // The chat the deferral was asked from, when it isn't the running lead's owner chat. The
    // server derives it from the item's source event; the wake-up works at no more than its level.
    origin: Schema.optional(KinEventOrigin),
  }),
  Schema.TaggedStruct("routine", {
    ...EventBase,
    routine: KinLeadRoutine,
    dueAt: Schema.optional(CanonicalUtcTimestamp),
    lateByMs: Schema.optional(NonNegativeInt),
    foldedRoutines: Schema.optional(
      Schema.Array(
        Schema.Struct({
          routine: KinLeadRoutine,
          dueAt: CanonicalUtcTimestamp,
        }),
      ),
    ),
    ownerCheckItems: Schema.optional(
      Schema.Array(
        Schema.Struct({
          itemId: KinMemoryItemId,
          reason: Schema.Literals(["past_review", "misleading", "old_low_trust", "no_evidence"]),
        }),
      ),
    ),
  }),
  Schema.TaggedStruct("watchdog", {
    ...EventBase,
    finding: Schema.String,
    itemIds: Schema.Array(KinMemoryItemId),
  }),
  Schema.TaggedStruct("worker.report", {
    ...EventBase,
    workerId: KinWorkerId,
    report: WorkerReport,
    // From the worker's stored row, when it isn't the lead's owner chat: the chat its work was
    // asked for in, where the lead answers. `origin` is where that was first asked, with the
    // teammate who asked, as on a due deferral.
    chatId: Schema.optional(KinChatId),
    origin: Schema.optional(KinEventOrigin),
  }),
  Schema.TaggedStruct("action.resolved", {
    ...EventBase,
    pendingActionId: TrimmedNonEmptyString,
    outcome: Schema.Literals(["executed", "rejected", "expired", "failed"]),
  }),
  Schema.TaggedStruct("resume", {
    ...EventBase,
    pausedAt: CanonicalUtcTimestamp,
    // Events queued more than 24 hours before the resume are expired, not replayed.
    expired: Schema.Struct({
      count: NonNegativeInt,
      events: Schema.Array(
        Schema.Struct({
          eventId: KinEventId,
          tag: TrimmedNonEmptyString,
          receivedAt: CanonicalUtcTimestamp,
        }),
      ).check(Schema.isMaxLength(50)),
    }),
  }),
]);
export type KinEvent = typeof KinEvent.Type;

export const KinBudgetLimits = Schema.Struct({
  leadUnits: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  workerUnits: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type KinBudgetLimits = typeof KinBudgetLimits.Type;
export const KinBudget = Schema.Struct({
  orgId: KinOrgId,
  day: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
    Schema.makeFilter(
      (value) =>
        Option.exists(
          DateTime.make(`${value}T00:00:00.000Z`),
          (dateTime) => DateTime.formatIsoDate(dateTime) === value,
        ),
      { expected: "a real YYYY-MM-DD calendar date" },
    ),
  ),
  leadUnits: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  workerUnits: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  limits: KinBudgetLimits,
  // Today's lead units by lead, largest first; the limit stays one figure for the org.
  leads: Schema.optional(
    Schema.Array(
      Schema.Struct({
        agentId: KinAgentId,
        name: Schema.String,
        leadUnits: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
  ),
});
export type KinBudget = typeof KinBudget.Type;
export const KinBudgetGetInput = Schema.Struct({ orgId: KinOrgId });
export type KinBudgetGetInput = typeof KinBudgetGetInput.Type;
export const KinBudgetSetInput = Schema.Struct({ orgId: KinOrgId, limits: KinBudgetLimits });
export type KinBudgetSetInput = typeof KinBudgetSetInput.Type;

export const KinOrgState = Schema.Union([
  Schema.Struct({
    orgId: KinOrgId,
    paused: Schema.Literal(false),
    pausedAt: Schema.Null,
    pausedBy: Schema.Null,
    reason: Schema.Null,
  }),
  Schema.Struct({
    orgId: KinOrgId,
    paused: Schema.Literal(true),
    pausedAt: CanonicalUtcTimestamp,
    pausedBy: KinPersonId,
    reason: Schema.NullOr(Schema.String),
  }),
]);
export type KinOrgState = typeof KinOrgState.Type;
export const KinOrgPauseInput = Schema.Struct({
  orgId: KinOrgId,
  reason: Schema.optional(Schema.String),
});
export type KinOrgPauseInput = typeof KinOrgPauseInput.Type;
export const KinOrgResumeInput = Schema.Struct({ orgId: KinOrgId });
export type KinOrgResumeInput = typeof KinOrgResumeInput.Type;
export const KinOrgGetInput = Schema.Struct({ orgId: KinOrgId });
export type KinOrgGetInput = typeof KinOrgGetInput.Type;
