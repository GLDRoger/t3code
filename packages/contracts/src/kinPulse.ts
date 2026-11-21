import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId, KinPersonId } from "./kinChat.ts";
import { CanonicalUtcTimestamp, KinMemoryItemId } from "./kinLead.ts";
import { KinCurrency, KinDay } from "./kinMoney.ts";
import { KinRecordId, KinRecordKey } from "./kinWork.ts";

/**
 * The pulse: what needs attention, computed by Kin from its own rows as facts. Code states each
 * fact and its consequence; the agent woken by it decides what, if anything, to do.
 */

const KIN_PULSE_SENSES = [
  "task_late",
  "task_due_soon",
  "task_stalled",
  "waiting_long",
  "theirs_late",
  "to_confirm",
  "invoice_overdue",
  "quote_unanswered",
  "retainer_due",
  "renewal_due",
  "budget_over",
  "budget_near",
  // Workers are gone; facts already stored still decode.
  "worker_failed",
  "task_stuck",
  "work_held",
  "client_quiet",
  "client_cold",
  "client_waiting_on_us",
  "goal_behind",
  "pr_open_long",
  "pr_failing",
  "pr_review_waiting",
  "pr_ready",
  "milestone_late",
  "milestone_at_risk",
  "project_no_plan",
  "project_quiet",
  "spec_changed",
  "meeting_passed",
  "meeting_soon",
  "holder_removed",
  "statement_missing",
  "deal_no_next_step",
  "deal_quiet",
  "deal_date_passed",
  "mail_not_syncing",
] as const;
/**
 * Senses newer than the first phones: a screen read sends them only to a client that lists them
 * in `acceptSenses`, so an older client never meets a sense it can't decode.
 */
export const KIN_PULSE_LATER_SENSES = [
  "holder_removed",
  "statement_missing",
  "deal_no_next_step",
  "deal_quiet",
  "deal_date_passed",
  "mail_not_syncing",
] as const;
export const KinPulseSense = Schema.Literals(KIN_PULSE_SENSES);
export type KinPulseSense = typeof KinPulseSense.Type;

/**
 * Work facts are about tasks; money facts are the owner's alone; system facts are about Kin;
 * goal facts are about the company's goals (a money goal's are sensitive); code facts, open PRs.
 */
export const KinPulseFamily = Schema.Literals(["work", "money", "system", "goals", "code"]);
export type KinPulseFamily = typeof KinPulseFamily.Type;

/** `now` wakes the actor once; `sweep` waits for a check-in or a read; `brief` only in briefs. */
export const KinPulseWake = Schema.Literals(["now", "sweep", "brief"]);
export type KinPulseWake = typeof KinPulseWake.Type;

/** Who should act: an agent, a person, or the owner. */
export const KinPulseActor = Schema.Union([
  Schema.TaggedStruct("agent", { agentId: KinAgentId }),
  Schema.TaggedStruct("person", { personId: KinPersonId }),
  Schema.TaggedStruct("owner", {}),
]);
export type KinPulseActor = typeof KinPulseActor.Type;

export const KinPulseHandled = Schema.Struct({
  by: Schema.Union([
    Schema.TaggedStruct("agent", { agentId: KinAgentId }),
    Schema.TaggedStruct("person", { personId: KinPersonId }),
  ]),
  at: CanonicalUtcTimestamp,
  /** Hidden until then; null closes this episode for good ("not a problem"). */
  until: Schema.NullOr(CanonicalUtcTimestamp),
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});
export type KinPulseHandled = typeof KinPulseHandled.Type;

/**
 * A record set aside: nothing about it, and for a client or project nothing under it, is told or
 * asked until `until` (null: until someone lifts it). A teammate's own (`mine`) hides it for them.
 */
export const KinPulseAside = Schema.Struct({
  record: Schema.Struct({
    key: KinRecordKey,
    title: Schema.String.check(Schema.isMaxLength(280)),
  }),
  /** `all`: the record and everything under it (a client or project); `only`: that record. */
  covers: Schema.Literals(["all", "only"]),
  until: Schema.NullOr(CanonicalUtcTimestamp),
  by: KinPulseHandled.fields.by,
  /** The person whose word it was, when an agent set it. */
  onWordOf: Schema.NullOr(KinPersonId),
  /** Only this reader's own view (a teammate's), not the company's. */
  mine: Schema.Boolean,
  at: CanonicalUtcTimestamp,
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  /** Whether this reader may lift it. */
  liftable: Schema.Boolean,
  /** This reader set it, or it was set on this reader's word. */
  byYou: Schema.Boolean,
  yourWord: Schema.Boolean,
});
export type KinPulseAside = typeof KinPulseAside.Type;

export const KinPulseThresholdSource = Schema.Union([
  Schema.TaggedStruct("default", {}),
  Schema.TaggedStruct("playbook", { key: Schema.String, title: Schema.String }),
]);
export type KinPulseThresholdSource = typeof KinPulseThresholdSource.Type;

export const KinPulseFact = Schema.Struct({
  sense: KinPulseSense,
  family: KinPulseFamily,
  /** Sense, subject and episode: a moved due date is a new key, so a new fact. */
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  subject: Schema.Struct({
    // `bank` and `connection` come only with later senses, so an older client never meets them.
    kind: Schema.Literals([
      "record",
      "worker",
      "task",
      "budget",
      "agent",
      "pull_request",
      "bank",
      "connection",
    ]),
    /**
     * A record's key (INV-4), a task's thread, an agent id, a budget id, owner/name#12 (PR), or a
     * connection id.
     */
    key: TrimmedNonEmptyString,
    title: Schema.String.check(Schema.isMaxLength(280)),
    recordId: Schema.optional(KinRecordId),
    /** A record's issued number (INV/26-27/004), once it has one. */
    number: Schema.optional(TrimmedNonEmptyString),
  }),
  scope: Schema.Struct({
    projectKey: Schema.optional(Schema.String),
    projectTitle: Schema.optional(Schema.String),
    clientKey: Schema.optional(Schema.String),
    clientTitle: Schema.optional(Schema.String),
  }),
  /** When it became true. */
  since: CanonicalUtcTimestamp,
  measure: Schema.optional(
    Schema.Struct({
      value: Schema.Finite,
      unit: Schema.Literals(["hours", "days", "percent", "count"]),
      threshold: Schema.Finite,
      /** Where the threshold came from: the code default, or the playbook doc that sets it. */
      from: KinPulseThresholdSource,
    }),
  ),
  /** Built by code from stored fields, such as "₹1,77,000 owed, 10 days past due". */
  consequence: Schema.String.check(Schema.isMaxLength(500)),
  actor: KinPulseActor,
  sensitive: Schema.Boolean,
  wake: KinPulseWake,
  handled: Schema.NullOr(KinPulseHandled),
  /** A renewal's stage: mentioned ahead (`heads_up`), or inside the days to draft it (`draft`). */
  stage: Schema.optional(Schema.Literals(["heads_up", "draft"])),
  /** Set aside with its record, client or project; `handled` then says so for older clients. */
  aside: Schema.optional(KinPulseAside),
});
export type KinPulseFact = typeof KinPulseFact.Type;

/** A filter on facts; empty is the whole company. */
export const KinPulseScope = Schema.Struct({
  project: Schema.optional(TrimmedNonEmptyString),
  client: Schema.optional(TrimmedNonEmptyString),
  family: Schema.optional(KinPulseFamily),
});
export type KinPulseScope = typeof KinPulseScope.Type;

/** What a `limit`ed screen read leaves out, counted over every fact it would have sent. */
export const KinPulseOutline = Schema.Struct({
  /** Not handled by anyone: the Tasks badge. */
  open: NonNegativeInt,
  /** Of those, in the money family, and whether one of them is urgent. */
  money: NonNegativeInt,
  moneyUrgent: Schema.Boolean,
  /** The record keys every fact is about, handled ones included. */
  records: Schema.Array(Schema.String),
  /** An invoice is overdue (an `invoice_overdue:` fact, handled or not). */
  invoiceOverdue: Schema.Boolean,
});
export type KinPulseOutline = typeof KinPulseOutline.Type;

export const KinPulseRead = Schema.Struct({
  asOf: CanonicalUtcTimestamp,
  /** Facts matching, before the cap. */
  total: NonNegativeInt,
  facts: Schema.Array(KinPulseFact),
  /** With `includeHandled`: what this reader sees set aside, one per record, facts or none. */
  setAside: Schema.optional(Schema.Array(KinPulseAside)),
});
export type KinPulseRead = typeof KinPulseRead.Type;

/** `kin.pulse.read` for people's screens: `outline` comes with a `limit`. */
export const KinPulseScreenRead = Schema.Struct({
  ...KinPulseRead.fields,
  outline: Schema.optional(KinPulseOutline),
});
export type KinPulseScreenRead = typeof KinPulseScreenRead.Type;

export const KinPulseHandleAction = Schema.Literals([
  "got_it",
  "not_a_problem",
  "undo",
  /** Its record set aside (`KinPulseAside`): until `until`, else until lifted. */
  "set_aside",
]);
export type KinPulseHandleAction = typeof KinPulseHandleAction.Type;

// People's side: what needs attention on their screens, and their three answers to it.

export const KinPulseListInput = Schema.Struct({
  orgId: KinOrgId,
  /** Also what someone has in hand or called not a problem, for the Handled list and its Undo. */
  includeHandled: Schema.optional(Schema.Boolean),
  /**
   * At most this many open facts, in the order Needs you shows them (urgent first, money last),
   * then every handled one, with `outline` counting the rest. Absent: every fact, up to 200.
   */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  /** Only facts about this project, client (by key) or family, as a screen about it shows them. */
  scope: Schema.optional(KinPulseScope),
  /** The later senses (`KIN_PULSE_LATER_SENSES`) this client reads; absent, none of them. */
  acceptSenses: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(Schema.isMaxLength(20)),
  ),
});
export type KinPulseListInput = typeof KinPulseListInput.Type;

/** `kin.pulse.subscribe`: the read `kin.pulse.read` makes, kept current as facts move. */
export const KinPulseSubscribeInput = Schema.Struct({
  ...KinPulseListInput.fields,
  /** The `hash` of the page held from an earlier session; unchanged, the stream starts `current`. */
  held: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type KinPulseSubscribeInput = typeof KinPulseSubscribeInput.Type;

const KinPulseFactKey = TrimmedNonEmptyString.check(Schema.isMaxLength(300));
/**
 * The first page whole (`snapshot`), or `current` when the held one still stands; then what moved
 * (`kinPulseApply`). `hash` names the page each leaves the client holding.
 */
export const KinPulseEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { read: KinPulseScreenRead, hash: Schema.String }),
  Schema.TaggedStruct("current", { hash: Schema.String }),
  Schema.TaggedStruct("changed", {
    asOf: CanonicalUtcTimestamp,
    total: NonNegativeInt,
    /** Absent: the held outline stands. */
    outline: Schema.optional(KinPulseOutline),
    /** New facts, and held ones that changed. */
    updated: Schema.Array(KinPulseFact),
    removed: Schema.Array(KinPulseFactKey),
    /** Every key in order; absent when it is the held order less `removed`, new ones last. */
    order: Schema.optional(Schema.Array(KinPulseFactKey)),
    /** Absent: the held list stands. */
    setAside: Schema.optional(Schema.Array(KinPulseAside)),
    hash: Schema.String,
  }),
]);
export type KinPulseEvent = typeof KinPulseEvent.Type;
export type KinPulseChange = Extract<KinPulseEvent, { readonly _tag: "changed" }>;

export const KinPulseHandleInput = Schema.Struct({
  orgId: KinOrgId,
  factKey: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  action: KinPulseHandleAction,
  /** For `got_it`: hidden until the start of this day in the owner's time zone; default 3 days. */
  until: Schema.optional(KinDay),
});
export type KinPulseHandleInput = typeof KinPulseHandleInput.Type;

/** `kin.pulse.aside`: set a record aside, or lift the hold on it, as the person asking. */
export const KinPulseAsideInput = Schema.Struct({
  orgId: KinOrgId,
  record: KinRecordKey,
  action: Schema.Literals(["set", "lift"]),
  /** For `set`: until the start of this day in the owner's time zone; absent, until lifted. */
  until: Schema.optional(KinDay),
});
export type KinPulseAsideInput = typeof KinPulseAsideInput.Type;
export const KinPulseAsideResult = Schema.Struct({ aside: Schema.NullOr(KinPulseAside) });
export type KinPulseAsideResult = typeof KinPulseAsideResult.Type;

// Company goals: a built-in list (`G-1`) whose progress the server computes.

/**
 * What a goal counts: money received in its period, clients won, tasks done, or a number someone
 * keeps up to date by hand (a release shipped, people hired).
 */
export const KIN_GOAL_MEASURES = [
  "revenue_received",
  "clients_won",
  "tasks_done",
  "manual",
] as const;
export const KinGoalMeasure = Schema.Literals(KIN_GOAL_MEASURES);
export type KinGoalMeasure = typeof KinGoalMeasure.Type;

export const KinGoal = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  title: Schema.String,
  rev: NonNegativeInt,
  state: Schema.Literals(["open", "done", "dropped"]),
  measure: KinGoalMeasure,
  /** Money measures: the currency `target`, `current` and `expected` are minor units in. */
  currency: Schema.optional(KinCurrency),
  /** What a manual number counts, such as "hires". */
  unit: Schema.optional(Schema.String),
  target: Schema.Finite,
  current: Schema.Finite,
  /** Where a straight line from start to target stands today. */
  expected: Schema.Finite,
  startsOn: KinDay,
  /** Null for a goal set without a date: it has no pace, so it is never behind. */
  dueOn: Schema.NullOr(KinDay),
  /** Behind the straight line by more than the playbook allows. */
  behind: Schema.Boolean,
});
export type KinGoal = typeof KinGoal.Type;

export const KinGoalsInput = Schema.Struct({ orgId: KinOrgId });
export type KinGoalsInput = typeof KinGoalsInput.Type;
export const KinGoalsResult = Schema.Struct({
  goals: Schema.Array(KinGoal),
  asOf: CanonicalUtcTimestamp,
});
export type KinGoalsResult = typeof KinGoalsResult.Type;

/** Adds a goal, or with `key` and `rev` changes one; `state` marks it reached or drops it. */
export const KinGoalSaveInput = Schema.Struct({
  orgId: KinOrgId,
  key: Schema.optional(KinRecordKey),
  rev: Schema.optional(NonNegativeInt),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  measure: KinGoalMeasure,
  /** As written: "40 lakh", "₹40,00,000", "12". */
  target: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  /** A manual goal's number now. */
  current: Schema.optional(Schema.NullOr(Schema.Finite)),
  unit: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(40)))),
  startsOn: KinDay,
  dueOn: KinDay,
  state: Schema.optional(Schema.Literals(["open", "done", "dropped"])),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinGoalSaveInput = typeof KinGoalSaveInput.Type;

// Check-ins: the times an agent looks over the pulse, set in Kin Settings or in chat.

/** "09:30", in the owner's time zone. */
const KinClockTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
/** 0 is Sunday. */
const KinWeekdays = Schema.Array(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(6)),
).check(Schema.isMinLength(1), Schema.isMaxLength(7));

/** The morning and weekly briefs: on the weekly brief's day, the first one sent covers the other. */
export const KinCoveringBrief = Schema.Literals(["morning", "weekly"]);
export type KinCoveringBrief = typeof KinCoveringBrief.Type;

/** The pipeline's three lines on Monday's page. */
export const KinCheckInNumbers = Schema.Literals(["pipeline"]);
export type KinCheckInNumbers = typeof KinCheckInNumbers.Type;

export const KinCheckIn = Schema.Struct({
  scheduleId: KinMemoryItemId,
  title: Schema.String,
  /** What it is for, the owner's words. */
  what: Schema.String,
  agentId: KinAgentId,
  agentName: Schema.String,
  at: KinClockTime,
  days: KinWeekdays,
  /** Fires somewhere around `at`, not on the minute. */
  around: Schema.optional(Schema.Boolean),
  on: Schema.Boolean,
  /** A Run now that hasn't started yet. */
  runNowPending: Schema.Boolean,
  /** Not sent today, the company's day, because this brief came instead. */
  coveredToday: Schema.optional(KinCoveringBrief),
  /**
   * Kin's own counts added to its page; only the weekly brief has it, empty when none is on.
   * Absent from older hosts and on every other check-in.
   */
  numbers: Schema.optional(Schema.Array(KinCheckInNumbers)),
});
export type KinCheckIn = typeof KinCheckIn.Type;

export const KinCheckInsInput = Schema.Struct({ orgId: KinOrgId });
export type KinCheckInsInput = typeof KinCheckInsInput.Type;
export const KinCheckInsResult = Schema.Struct({
  /** The owner's time zone, which `at` is in. */
  zone: Schema.String,
  checkIns: Schema.Array(KinCheckIn),
  /** Who can run a new one. */
  agents: Schema.Array(Schema.Struct({ agentId: KinAgentId, name: Schema.String })),
});
export type KinCheckInsResult = typeof KinCheckInsResult.Type;

/** Adds a check-in, or with `scheduleId` changes one's time, days or words. */
export const KinCheckInSaveInput = Schema.Struct({
  orgId: KinOrgId,
  scheduleId: Schema.optional(KinMemoryItemId),
  agentId: KinAgentId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  what: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  at: KinClockTime,
  days: KinWeekdays,
});
export type KinCheckInSaveInput = typeof KinCheckInSaveInput.Type;

export const KinCheckInActInput = Schema.Struct({
  orgId: KinOrgId,
  scheduleId: KinMemoryItemId,
  /** `numbers_on` and `numbers_off` are the weekly brief's pipeline lines. */
  action: Schema.Literals([
    "run_now",
    "turn_off",
    "turn_on",
    "remove",
    "numbers_on",
    "numbers_off",
  ]),
});
export type KinCheckInActInput = typeof KinCheckInActInput.Type;

// Briefs: the seeded check-ins a person receives, as they set them for themselves in Settings.

export const KinBriefKind = Schema.Literals(["morning", "afternoon", "evening"]);
export type KinBriefKind = typeof KinBriefKind.Type;

export const KinBrief = Schema.Struct({
  kind: KinBriefKind,
  at: KinClockTime,
  days: KinWeekdays,
  /** Fires somewhere around `at`, not on the minute. */
  around: Schema.Boolean,
  on: Schema.Boolean,
  /** Not sent today, the company's day, because this brief came instead. */
  coveredToday: Schema.optional(KinCoveringBrief),
  /** A morning page Kin writes for this person itself, in their own time zone; no agent's brief. */
  page: Schema.optional(Schema.Boolean),
});
export type KinBrief = typeof KinBrief.Type;

export const KinBriefsInput = Schema.Struct({ orgId: KinOrgId });
export type KinBriefsInput = typeof KinBriefsInput.Type;
export const KinBriefsResult = Schema.Struct({
  /** The company time zone check-ins keep, which `at` is in; a morning page's own person's zone. */
  zone: Schema.String,
  /** Only the briefs this person receives; none for someone who receives none. */
  briefs: Schema.Array(KinBrief),
});
export type KinBriefsResult = typeof KinBriefsResult.Type;

/** Changes one of the caller's own briefs: its time and days, and whether it comes. */
export const KinBriefSaveInput = Schema.Struct({
  orgId: KinOrgId,
  kind: KinBriefKind,
  at: KinClockTime,
  days: KinWeekdays,
  on: Schema.Boolean,
  /** What the person changed: only these are taken. An older client sends none: all of it is. */
  changed: Schema.optional(Schema.Array(Schema.Literals(["at", "days", "on"]))),
});
export type KinBriefSaveInput = typeof KinBriefSaveInput.Type;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinPulseRpcs = [
  Rpc.make("kin.pulse.read", { payload: KinPulseListInput, success: KinPulseScreenRead, error }),
  Rpc.make("kin.pulse.subscribe", {
    payload: KinPulseSubscribeInput,
    success: KinPulseEvent,
    error,
    stream: true,
  }),
  Rpc.make("kin.pulse.handle", { payload: KinPulseHandleInput, success: KinPulseFact, error }),
  Rpc.make("kin.pulse.aside", {
    payload: KinPulseAsideInput,
    success: KinPulseAsideResult,
    error,
  }),
  Rpc.make("kin.goals.list", { payload: KinGoalsInput, success: KinGoalsResult, error }),
  Rpc.make("kin.goals.save", { payload: KinGoalSaveInput, success: KinGoal, error }),
  Rpc.make("kin.checkIns.list", { payload: KinCheckInsInput, success: KinCheckInsResult, error }),
  Rpc.make("kin.checkIns.save", {
    payload: KinCheckInSaveInput,
    success: KinCheckInsResult,
    error,
  }),
  Rpc.make("kin.checkIns.act", { payload: KinCheckInActInput, success: KinCheckInsResult, error }),
  Rpc.make("kin.briefs.list", { payload: KinBriefsInput, success: KinBriefsResult, error }),
  Rpc.make("kin.briefs.save", { payload: KinBriefSaveInput, success: KinBriefsResult, error }),
] as const;

export const KIN_PULSE_RPC_SCOPES = {
  "kin.pulse.read": AuthKinChatScope,
  "kin.pulse.subscribe": AuthKinChatScope,
  "kin.pulse.handle": AuthKinChatScope,
  "kin.pulse.aside": AuthKinChatScope,
  "kin.goals.list": AuthKinChatScope,
  "kin.goals.save": AuthKinChatScope,
  "kin.checkIns.list": AuthKinChatScope,
  "kin.checkIns.save": AuthKinChatScope,
  "kin.checkIns.act": AuthKinChatScope,
  "kin.briefs.list": AuthKinChatScope,
  "kin.briefs.save": AuthKinChatScope,
} as const;
