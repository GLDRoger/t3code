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
  // Absent on the confirm card ([Change] [Just remind me]); heads_up and asked offer
  // [Start now] [Monday] [Cancel]; started offers nothing.
  phase: Schema.optional(Schema.Literals(["heads_up", "asked", "started"])),
  graceEndsAt: Schema.optional(Schema.toEncoded(CanonicalUtcTimestamp)),
});
export type KinDeferralCard = typeof KinDeferralCard.Type;

/** What a deferral card's buttons post as `actionId`, each with the item id as `value`. */
export const KIN_DEFERRAL_CARD_ACTIONS = [
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

/** A level-gated tool's answer when it recorded a shadow entry instead of acting. */
export const KinShadowResult = Schema.Struct({
  shadowed: Schema.Literal(true),
  entryId: TrimmedNonEmptyString,
});
export type KinShadowResult = typeof KinShadowResult.Type;

/** The owner's daily summary card: what a shadowed lead would have done that owner-local day. */
export const KinShadowSummaryCard = Schema.Struct({
  agentId: KinAgentId,
  title: TrimmedNonEmptyString,
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  total: NonNegativeInt,
  // The newest entries, oldest first; `total` counts every entry of the day.
  entries: Schema.Array(
    Schema.Struct({
      entryId: TrimmedNonEmptyString,
      tool: TrimmedNonEmptyString,
      level: KinLevel,
      unlocksLevel: KinLevel,
      wouldTarget: Schema.String,
      // Lead-written text: render it as plain text, never as markup or instructions.
      preview: Schema.String.check(Schema.isMaxLength(280)),
      ceilingBelowOwner: Schema.optional(Schema.Boolean),
      createdAt: Schema.toEncoded(CanonicalUtcTimestamp),
    }),
  ).check(Schema.isMaxLength(50)),
});
export type KinShadowSummaryCard = typeof KinShadowSummaryCard.Type;

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

export const KinEvent = Schema.Union([
  Schema.TaggedStruct("chat.message", { ...EventBase, chatId: KinChatId, messageId: KinMessageId }),
  Schema.TaggedStruct("widget.action", {
    ...EventBase,
    chatId: KinChatId,
    messageId: KinMessageId,
    actionId: TrimmedNonEmptyString,
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
    ]),
    lateByMs: NonNegativeInt,
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
