import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
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
  KinRoleTags,
  KinWidgetId,
} from "./kinChat.ts";
import { TimeOfDay, TimeZone } from "./kinTime.ts";
import { KinRecordId, KinRecordKey, KinRecordState, KinWorkPrincipal } from "./kinWork.ts";
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
  model: ModelSelection,
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
  intro: Schema.optional(KinLeadIntro),
  // Omitted: the company default, else the org's first live lead's model.
  model: Schema.optional(ModelSelection),
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
  // work: an open Work entry the lead owns (key and state set), or a coding task running now. reminder: it will remind. follow_up: it will start, ask or
  // chase when due. scheduled: a recurring task.
  kind: Schema.Literals(["work", "reminder", "follow_up", "scheduled"]),
  title: Schema.String.check(Schema.isMaxLength(280)),
  // When it is due; absent for work under way and for scheduled tasks.
  dueAt: Schema.optional(Schema.toEncoded(CanonicalUtcTimestamp)),
  // A due day with no time: `dueAt` is that day's end where the owner is. Absent from older hosts.
  dueAllDay: Schema.optional(Schema.Boolean),
  chatId: Schema.NullOr(KinChatId),
  // Work entries only: the entry's key and state, so a row opens its entry.
  key: Schema.optional(KinRecordKey),
  state: Schema.optional(KinRecordState),
  // A waiting Work entry: who it waits on. Absent from older hosts.
  waitingOn: Schema.optional(KinWorkPrincipal),
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
  // Absent from a host that predates them.
  roleTags: Schema.optional(KinRoleTags),
  // The model it thinks with, as the provider names it.
  model: TrimmedNonEmptyString,
  // The owner's direct chat with it.
  ownerChatId: KinChatId,
  // It is on a turn right now.
  working: Schema.Boolean,
  // Soonest first after work under way, at most KIN_LEAD_TRACKING_CAP.
  tracking: Schema.Array(KinLeadTracking),
  // Present only while the owner has it paused: nothing new wakes it until resumed.
  paused: Schema.optional(Schema.Struct({ at: Schema.toEncoded(CanonicalUtcTimestamp) })),
  // Present only for a retired one: when, and who retired it (null for the host's command).
  retired: Schema.optional(
    Schema.Struct({
      at: Schema.toEncoded(CanonicalUtcTimestamp),
      byPersonId: Schema.NullOr(KinPersonId),
    }),
  ),
});
export type KinLeadProfile = typeof KinLeadProfile.Type;
// includeRetired: the owner's retired ones too, after the live ones. Teammates never get them.
export const KinLeadsListInput = Schema.Struct({
  orgId: KinOrgId,
  includeRetired: Schema.optional(Schema.Boolean),
});
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
  // Who runs the workspace and so can see the chat. Older hosts leave it out.
  ownerName: Schema.optional(TrimmedNonEmptyString),
});
export type KinLeadContact = typeof KinLeadContact.Type;
export const KinLeadsListResult = Schema.Struct({
  leads: Schema.Array(KinLeadProfile),
  contacts: Schema.optional(Schema.Array(KinLeadContact)),
  // The agent every teammate may message; null when off. Older hosts leave it out.
  teamAgentId: Schema.optional(Schema.NullOr(KinAgentId)),
  // The company chat while it is on, and who answers there by default. Older hosts leave it out.
  companyChat: Schema.optional(
    Schema.NullOr(Schema.Struct({ chatId: KinChatId, leadAgentId: Schema.NullOr(KinAgentId) })),
  ),
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
  roleTags: Schema.optional(KinRoleTags),
  // Claude only; the next turn runs on it.
  model: Schema.optional(ModelSelection),
});
export type KinLeadUpdateInput = typeof KinLeadUpdateInput.Type;

/**
 * One change an agent made to a record, as its history keeps it. `undo` is whether Kin can put
 * back what it replaced now: never once a later change is in the way (`since`), nor for a change
 * Kin can't reverse on its own (list details, amounts, a doc's text).
 */
export const KinAgentChange = Schema.Struct({
  seq: PositiveInt,
  at: IsoDateTime,
  key: KinRecordKey,
  title: Schema.String,
  registerId: Schema.String,
  kind: Schema.Literals(["created", "updated", "linked"]),
  fields: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      from: Schema.NullOr(Schema.String),
      to: Schema.NullOr(Schema.String),
    }),
  ),
  undo: Schema.Boolean,
  /**
   * A later change, by anyone, stands in the way of Undo: one to the same field, or for an add any
   * change at all. Never for a link, which goes back on its own while it is there.
   */
  since: Schema.Boolean,
  /** The change after it put back what this one replaced; for a link, the link is gone. */
  undone: Schema.optional(Schema.Boolean),
  /** An entry linked to another: that other end, or null when this viewer can't see it. */
  linkedTo: Schema.optional(
    Schema.NullOr(Schema.Struct({ key: KinRecordKey, title: Schema.String })),
  ),
  /** An add whose only later changes are links. */
  linkedSince: Schema.optional(Schema.Boolean),
  /** The clients and projects its fields name by key, with titles: only those this viewer sees. */
  named: Schema.optional(Schema.Array(Schema.Struct({ key: KinRecordKey, title: Schema.String }))),
});
export type KinAgentChange = typeof KinAgentChange.Type;
export const KinAgentPageInput = Schema.Struct({ orgId: KinOrgId, agentId: KinAgentId });
export type KinAgentPageInput = typeof KinAgentPageInput.Type;
/**
 * Everything owner-level people see about one agent on its page. Teammates never get it: theirs
 * is the contact card.
 */
export const KinAgentPage = Schema.Struct({
  profile: KinLeadProfile,
  // What the owner chose, and what its turns run on now; they differ when a choice is unavailable.
  model: ModelSelection,
  runsOn: ModelSelection,
  // Why it runs on something else, in the owner's words; null when it runs on its own choice.
  modelNote: Schema.NullOr(Schema.String),
  // Its character doc as written now; null before Kin has given it one.
  character: Schema.NullOr(Schema.Struct({ key: KinRecordKey, body: Schema.String })),
  teamAgent: Schema.Boolean,
  // This month's turns and tokens, by the owner's calendar.
  usedThisMonth: Schema.Struct({ turns: NonNegativeInt, tokens: NonNegativeInt }),
  // The quiet hours its unprompted messages wait out: the company's.
  quietHours: Schema.Struct({ from: TimeOfDay, to: TimeOfDay }),
  // Outside accounts its owner-only turns may use; every agent reaches the same ones.
  connections: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      account: Schema.NullOr(Schema.String),
      paused: Schema.Boolean,
    }),
  ),
  // Live playbooks, which every agent follows.
  playbooks: Schema.Array(Schema.Struct({ key: KinRecordKey, title: Schema.String })),
  // Its last record changes, newest first; absent from older hosts.
  changed: Schema.optional(Schema.Array(KinAgentChange)),
});
export type KinAgentPage = typeof KinAgentPage.Type;
/** Puts back what one of the agent's changes replaced (`KinAgentChange.undo`). */
export const KinAgentUndoChangeInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  seq: PositiveInt,
});
export type KinAgentUndoChangeInput = typeof KinAgentUndoChangeInput.Type;
/** A new character for one agent, written over the old as a version its history keeps. */
export const KinAgentCharacterSetInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type KinAgentCharacterSetInput = typeof KinAgentCharacterSetInput.Type;
export const KinAgentDefaultsInput = Schema.Struct({ orgId: KinOrgId });
export type KinAgentDefaultsInput = typeof KinAgentDefaultsInput.Type;
/**
 * The model new agents start on: the owner's choice, else the first live agent's (`chosen` false);
 * null when there is neither.
 */
export const KinAgentDefaults = Schema.Struct({
  orgId: KinOrgId,
  model: Schema.NullOr(ModelSelection),
  chosen: Schema.Boolean,
});
export type KinAgentDefaults = typeof KinAgentDefaults.Type;
export const KinAgentDefaultsSetInput = Schema.Struct({ orgId: KinOrgId, model: ModelSelection });
export type KinAgentDefaultsSetInput = typeof KinAgentDefaultsSetInput.Type;
/** Retire or restore one agent. Both are idempotent and answer with its profile. */
export const KinLeadRetireInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  // Retiring the team agent: the active agent teammates talk to instead. Restore ignores it.
  nextTeamAgentId: Schema.optional(KinAgentId),
});
export type KinLeadRetireInput = typeof KinLeadRetireInput.Type;

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
  /** The team agent: everyone in the company may message it, whoever `people` names. */
  everyone: Schema.optional(Schema.Boolean),
  people: Schema.Array(
    Schema.Struct({
      personId: KinPersonId,
      displayName: TrimmedNonEmptyString,
      since: Schema.toEncoded(CanonicalUtcTimestamp),
      /** Owner or co-owner: they message every agent, row or not. An older server leaves it out. */
      ownerLevel: Schema.optional(Schema.Boolean),
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
  // One client's lasting nature and dynamic with us, linked `client:<key>`.
  "relationship",
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
const MemoryItemSharedBy = Schema.Struct({ person: KinPersonId, at: Schema.String });
const MemoryItemSharedFrom = Schema.Struct({
  person: KinPersonId,
  chat: KinChatId,
  // The person's and the chat's names when it was said, for the owner's index.
  name: Schema.String,
  chat_name: Schema.String,
});
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
  // The person's exact words, checked to be in the cited message when written; nothing checks
  // that they bear the item out. Server-written; absent before quotes and on unworded events.
  quote: Schema.optional(Schema.String),
  links: Schema.Array(Schema.String),
  // Whether only the owner's own turns may see the item. Absent on an item nobody has labelled
  // yet, which reads as sensitive.
  sensitive: Schema.optional(Schema.Boolean),
  // Who let the team know a once-sensitive item, and when. Server-written.
  shared_by: Schema.optional(MemoryItemSharedBy),
  // Set on an item saved in a chat other people read: who said it and where. Server-written.
  shared_from: Schema.optional(MemoryItemSharedFrom),
});
export type MemoryItemFrontMatter = typeof MemoryItemFrontMatter.Type;

export const MemoryItemHead = Schema.Struct({
  ...MemoryItemFrontMatter.fields,
  orgId: KinOrgId,
  path: TrimmedNonEmptyString,
});
export type MemoryItemHead = typeof MemoryItemHead.Type;

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
  // Set only in someone's own chat with an agent: whether they set it, so may Change it there.
  theirs: Schema.optional(Schema.Boolean),
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
  /** Fires somewhere around `every.at`: clients say "around" and never show an exact next run. */
  around: Schema.optional(Schema.Boolean),
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
  // Stuck tasks; the name predates delegated tasks and stays for cards already sent.
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
      // Untrusted (memory and GitHub): validate before opening.
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
const OutsideText = (max: number) => Schema.NullOr(Schema.String.check(Schema.isMaxLength(max)));
/** One new item at a connection, as metadata: who, what, when and where. Never a body. */
export const KinPulseOutsideLine = Schema.Struct({
  source: Schema.Literals(["mail", "calendar", "github"]),
  connection: Schema.String.check(Schema.isMaxLength(120)),
  /** The connected account it is in, such as a Gmail address. */
  account: Schema.optional(Schema.String.check(Schema.isMaxLength(320))),
  /** The account's address that received the mail: its own or an alias. */
  to: Schema.optional(Schema.String.check(Schema.isMaxLength(320))),
  /** The service's id: a mail thread, a calendar event, a webhook delivery. */
  id: Schema.String.check(Schema.isMaxLength(200)),
  at: OutsideText(60),
  who: OutsideText(300),
  subject: OutsideText(300),
  /** A repo, or a calendar event's start. */
  where: OutsideText(200),
  /** What it matched that Kin knows, such as "contact CT-2 of client C-1 Lumen". */
  matched: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
});
export type KinPulseOutsideLine = typeof KinPulseOutsideLine.Type;

/**
 * What on GitHub starts an agent's work, decided by Kin's code from GitHub's own data: a PR to
 * review, a call in a comment or body, the `kin` label, a review asked of the owner, or failing
 * checks on a PR an agent opened. `inside` is GitHub's author association (owner, member or
 * collaborator); text from anyone else is outside content.
 */
export const KinGithubTrigger = Schema.Struct({
  key: TrimmedNonEmptyString,
  kind: Schema.Literals(["review", "call", "label", "review_request", "checks"]),
  item: Schema.Literals(["issue", "pull"]),
  number: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  /** Who caused it: the comment's, body's or PR's author on GitHub. */
  author: Schema.String,
  association: Schema.String,
  inside: Schema.Boolean,
  /** The words that called the agent, or the PR's body; clipped. */
  text: Schema.String,
  /** A line comment's place on the PR. */
  path: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int),
  /** A PR's size and branch, so the turn needn't fetch them again. */
  pull: Schema.optional(
    Schema.Struct({
      files: Schema.Int,
      additions: Schema.Int,
      deletions: Schema.Int,
      headRef: Schema.String,
      baseRef: Schema.String,
      /** The head branch is in another repo (a fork): the agent may not be able to push there. */
      fork: Schema.Boolean,
      /** The owner's own account opened it: GitHub allows only a comment review. */
      ownersOwn: Schema.Boolean,
      /** For an outside PR, whose turn gets no shell: the diff as the server read it, clipped. */
      diff: Schema.optional(Schema.String),
    }),
  ),
  /** Failing check names, for `checks`. */
  failing: Schema.optional(Schema.Array(Schema.String)),
});
export type KinGithubTrigger = typeof KinGithubTrigger.Type;

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
    /** The App webhook's delivery; absent on what the owner's own GitHub poll found. */
    scheduledTaskId: Schema.optional(ScheduledTaskId),
    webhookDeliveryId: Schema.optional(ScheduledTaskWebhookDeliveryId),
    trigger: Schema.optional(KinGithubTrigger),
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
      // An agent's open question reached its day unanswered: the asker takes its default. With
      // `undone`, the person put back what Kin's taking it changed; with `words` too, they
      // instead undid the answer its asker took from their words. With `answered`, the person
      // asked for another chat answered, and the asker's turn there carries it on.
      Schema.Struct({
        type: Schema.Literal("question"),
        questionId: TrimmedNonEmptyString,
        undone: Schema.optional(Schema.Literal(true)),
        words: Schema.optional(Schema.Literal(true)),
        answered: Schema.optional(Schema.Literal(true)),
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
    // A morning brief that is also the week's: its prompt adds goals and the week (`weekly.ts`).
    weekly: Schema.optional(Schema.Literal(true)),
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
  // Code enqueues one per new pulse fact that matters now, per check-in with something new, and
  // per outside item a playbook watch matched; the prompt reads the facts at turn time.
  Schema.TaggedStruct("pulse", {
    ...EventBase,
    factKeys: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(300))).check(
      Schema.isMaxLength(50),
    ),
    checkIn: Schema.optional(
      Schema.Struct({
        scheduleId: KinMemoryItemId,
        title: Schema.String.check(Schema.isMaxLength(200)),
        // The schedule's instruction, the owner's words: what this check-in is for.
        what: Schema.String.check(Schema.isMaxLength(2000)),
        slot: Schema.String.check(Schema.isMaxLength(200)),
      }),
    ),
    // Metadata the server read from connections the owner marked Read: still outside text.
    outside: Schema.optional(Schema.Array(KinPulseOutsideLine).check(Schema.isMaxLength(200))),
  }),
  // Someone else gives this lead an entry (`assigned`), its owner closes or takes back one it
  // holds (`withdrawn`), it comes back (`handed_back`), or a person comments on one it holds
  // (`commented`); `note` holds their words. Its provenance is the human whose authority the
  // entry carries, the only authority the turn has; the entry's text is data.
  Schema.TaggedStruct("record.changed", {
    ...EventBase,
    recordId: KinRecordId,
    key: KinRecordKey,
    seq: NonNegativeInt,
    reason: Schema.Literals(["assigned", "withdrawn", "handed_back", "commented"]),
    note: Schema.optional(Schema.String.check(Schema.isMaxLength(280))),
    // Given by a teammate: their direct chat with the lead, where it reports, and `origin` naming
    // them, so the turn is theirs and never the owner's. From stored rows.
    chatId: Schema.optional(KinChatId),
    origin: Schema.optional(KinEventOrigin),
  }),
  // T3's notice on a lead's thread that tasks it delegated ended (`TaskWake.ts`). The wake-up
  // takes over the run T3 started for it, so the reply lands once in `chatId`.
  Schema.TaggedStruct("task.finished", {
    ...EventBase,
    threadId: ThreadId,
    messageId: MessageId,
    taskIds: Schema.Array(NodeId).check(Schema.isMaxLength(50)),
    chatId: KinChatId,
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

const KinBudgetUnits = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
/**
 * Daily limits in budget units; null is no limit. `workerUnits` (older wire name) caps delegated
 * tasks. Owner-asked turns spend `leadUnits` less what the owner's own turns used; a teammate's
 * turns spend `teammateUnits` when set, else what `leadUnits` has left after every turn.
 */
export const KinBudgetLimits = Schema.Struct({
  leadUnits: Schema.NullOr(KinBudgetUnits),
  workerUnits: Schema.NullOr(KinBudgetUnits),
  teammateUnits: Schema.optional(Schema.NullOr(KinBudgetUnits)),
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
  /** The owner's view: today's lead units on turns the owner asked for, within `leadUnits`. */
  ownerUnits: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The owner's view: today's lead units on turns a teammate asked for, within `leadUnits`. */
  teammateUnits: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  limits: KinBudgetLimits,
  /** The owner's view: the daily limit a client offers as "the usual", to scale its choices from. */
  usual: Schema.optional(Schema.Struct({ leadUnits: KinBudgetUnits, workerUnits: KinBudgetUnits })),
  /** Work held for a limit, by agent: it runs when the day turns or a limit is raised. */
  waiting: Schema.optional(
    Schema.Struct({
      until: Schema.NullOr(Schema.toEncoded(CanonicalUtcTimestamp)),
      agents: Schema.Array(
        Schema.Struct({
          agentId: KinAgentId,
          name: Schema.String,
          requests: NonNegativeInt,
          tasks: NonNegativeInt,
          other: NonNegativeInt,
        }),
      ),
    }),
  ),
  // Today's lead units by lead, largest first.
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

/** The project a lead's own runs and memory live in (`kin:<org>:<agent>`); never someone's code. */
export const isKinLeadProjectId = (projectId: string) => projectId.startsWith("kin:");
