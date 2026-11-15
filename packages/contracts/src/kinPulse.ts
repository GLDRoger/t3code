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
  "worker_failed",
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
    kind: Schema.Literals(["record", "worker", "budget", "agent", "pull_request"]),
    /** A record's key (INV-4), a worker or agent id, a budget's id, or owner/name#12 for a PR. */
    key: TrimmedNonEmptyString,
    title: Schema.String.check(Schema.isMaxLength(280)),
    recordId: Schema.optional(KinRecordId),
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
});
export type KinPulseFact = typeof KinPulseFact.Type;

/** A filter on facts; empty is the whole company. */
export const KinPulseScope = Schema.Struct({
  project: Schema.optional(TrimmedNonEmptyString),
  client: Schema.optional(TrimmedNonEmptyString),
  family: Schema.optional(KinPulseFamily),
});
export type KinPulseScope = typeof KinPulseScope.Type;

export const KinPulseRead = Schema.Struct({
  asOf: CanonicalUtcTimestamp,
  /** Facts matching, before the cap. */
  total: NonNegativeInt,
  facts: Schema.Array(KinPulseFact),
});
export type KinPulseRead = typeof KinPulseRead.Type;

export const KinPulseHandleAction = Schema.Literals(["got_it", "not_a_problem", "undo"]);
export type KinPulseHandleAction = typeof KinPulseHandleAction.Type;

// People's side: what needs attention on their screens, and their three answers to it.

export const KinPulseListInput = Schema.Struct({
  orgId: KinOrgId,
  /** Also what someone has in hand or called not a problem, for the Handled list and its Undo. */
  includeHandled: Schema.optional(Schema.Boolean),
});
export type KinPulseListInput = typeof KinPulseListInput.Type;

export const KinPulseHandleInput = Schema.Struct({
  orgId: KinOrgId,
  factKey: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  action: KinPulseHandleAction,
  /** For `got_it`: hidden until the start of this day in the owner's time zone; default 3 days. */
  until: Schema.optional(KinDay),
});
export type KinPulseHandleInput = typeof KinPulseHandleInput.Type;

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

export const KinCheckIn = Schema.Struct({
  scheduleId: KinMemoryItemId,
  title: Schema.String,
  /** What it is for, the owner's words. */
  what: Schema.String,
  agentId: KinAgentId,
  agentName: Schema.String,
  at: KinClockTime,
  days: KinWeekdays,
  on: Schema.Boolean,
  /** A Run now that hasn't started yet. */
  runNowPending: Schema.Boolean,
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
  action: Schema.Literals(["run_now", "turn_off", "turn_on", "remove"]),
});
export type KinCheckInActInput = typeof KinCheckInActInput.Type;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinPulseRpcs = [
  Rpc.make("kin.pulse.read", { payload: KinPulseListInput, success: KinPulseRead, error }),
  Rpc.make("kin.pulse.handle", { payload: KinPulseHandleInput, success: KinPulseFact, error }),
  Rpc.make("kin.goals.list", { payload: KinGoalsInput, success: KinGoalsResult, error }),
  Rpc.make("kin.goals.save", { payload: KinGoalSaveInput, success: KinGoal, error }),
  Rpc.make("kin.checkIns.list", { payload: KinCheckInsInput, success: KinCheckInsResult, error }),
  Rpc.make("kin.checkIns.save", {
    payload: KinCheckInSaveInput,
    success: KinCheckInsResult,
    error,
  }),
  Rpc.make("kin.checkIns.act", { payload: KinCheckInActInput, success: KinCheckInsResult, error }),
] as const;

export const KIN_PULSE_RPC_SCOPES = {
  "kin.pulse.read": AuthKinChatScope,
  "kin.pulse.handle": AuthKinChatScope,
  "kin.goals.list": AuthKinChatScope,
  "kin.goals.save": AuthKinChatScope,
  "kin.checkIns.list": AuthKinChatScope,
  "kin.checkIns.save": AuthKinChatScope,
  "kin.checkIns.act": AuthKinChatScope,
} as const;
