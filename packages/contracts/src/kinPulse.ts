import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinPersonId } from "./kinChat.ts";
import { CanonicalUtcTimestamp } from "./kinLead.ts";
import { KinRecordId } from "./kinWork.ts";

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
] as const;
export const KinPulseSense = Schema.Literals(KIN_PULSE_SENSES);
export type KinPulseSense = typeof KinPulseSense.Type;

/** Work facts are about tasks; money facts are the owner's alone; system facts are about Kin. */
export const KinPulseFamily = Schema.Literals(["work", "money", "system"]);
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

export const KinPulseFact = Schema.Struct({
  sense: KinPulseSense,
  family: KinPulseFamily,
  /** Sense, subject and episode: a moved due date is a new key, so a new fact. */
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  subject: Schema.Struct({
    kind: Schema.Literals(["record", "worker", "budget", "agent"]),
    /** A record's key (INV-4), a worker or agent id, or a budget's id. */
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
      /** Where the threshold came from: the code default until playbooks set one. */
      from: Schema.Literal("default"),
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
