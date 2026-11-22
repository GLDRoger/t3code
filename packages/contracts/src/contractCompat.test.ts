import * as Schema from "effect/Schema";
import { expect, it } from "vitest";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinLabelText } from "./kinChat.ts";
import { KinListsResult as CurrentLists } from "./kinFinance.ts";
import { CanonicalUtcTimestamp } from "./kinLead.ts";
import { KinCurrency, KinDay, KinListFieldKey, KinListId } from "./kinMoney.ts";
import {
  KIN_PULSE_LATER_SENSES,
  KinGoalsResult as CurrentGoals,
  KinPulseActor,
  KinPulseAside,
  KinPulseHandled,
  KinPulseOutline,
  KinPulseScreenRead as CurrentPulse,
  KinPulseThresholdSource,
  KinPulseWake,
} from "./kinPulse.ts";
import { KinRecordId, KinRecordKey, KinRecordState } from "./kinWork.ts";

// Previous wire schemas frozen from 71b9271c8b86fbdf1646cfb9e5a83bb7e0737940 (shared primitives unchanged).
const KinListFieldType = Schema.Literals([
  "text",
  "choice",
  "date",
  "person",
  "link",
  "money",
  "file",
]);

const Label = KinLabelText.check(Schema.isMaxLength(60));

const KinListField = Schema.Struct({
  key: KinListFieldKey,
  label: Label,
  type: KinListFieldType,
  choices: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(30))),
  link: Schema.optional(Schema.Literals(["clients", "projects"])),
  sensitive: Schema.Boolean,
  retired: Schema.optional(Schema.Literal(true)),
});

const KinStateLabels = Schema.Struct({
  open: Schema.optional(Label),
  doing: Schema.optional(Label),
  waiting: Schema.optional(Label),
  done: Schema.optional(Label),
  dropped: Schema.optional(Label),
});

const KinNumberingRule = Schema.Struct({
  prefix: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,8}$/)),
  series: Schema.Literals(["financial_year", "running"]),
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(6)),
});

const KinListDefinition = Schema.Struct({
  list: KinListId,
  name: Label,
  prefix: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,5}$/)),
  builtIn: Schema.Boolean,
  states: Schema.Array(KinRecordState),
  stateLabels: KinStateLabels,
  defaultState: KinRecordState,
  categories: Schema.Array(Label),
  categoryLabels: Schema.optional(Schema.Record(Schema.String, Label)),
  fields: Schema.Array(KinListField),
  sensitive: Schema.Boolean,
  amount: Schema.Boolean,
  currency: KinCurrency,
  payments: Schema.optional(Schema.Literal(true)),
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
  numbering: Schema.optional(KinNumberingRule),
  archivedAt: Schema.NullOr(IsoDateTime),
  rev: NonNegativeInt,
  open: NonNegativeInt,
});

const KinListsResult = Schema.Struct({ lists: Schema.Array(KinListDefinition) });

const KIN_GOAL_MEASURES = ["revenue_received", "clients_won", "tasks_done", "manual"] as const;

const KinGoalMeasure = Schema.Literals(KIN_GOAL_MEASURES);

const KinGoal = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  title: Schema.String,
  rev: NonNegativeInt,
  state: Schema.Literals(["open", "done", "dropped"]),
  measure: KinGoalMeasure,
  currency: Schema.optional(KinCurrency),
  unit: Schema.optional(Schema.String),
  target: Schema.Finite,
  current: Schema.Finite,
  expected: Schema.Finite,
  startsOn: KinDay,
  dueOn: Schema.NullOr(KinDay),
  behind: Schema.Boolean,
});

const KinGoalsResult = Schema.Struct({
  goals: Schema.Array(KinGoal),
  asOf: CanonicalUtcTimestamp,
});

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
] as const;

const KinPulseSense = Schema.Literals(KIN_PULSE_SENSES);

const KinPulseFamily = Schema.Literals(["work", "money", "system", "goals", "code"]);

const KinPulseFact = Schema.Struct({
  sense: KinPulseSense,
  family: KinPulseFamily,
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  subject: Schema.Struct({
    kind: Schema.Literals(["record", "worker", "task", "budget", "agent", "pull_request", "bank"]),
    key: TrimmedNonEmptyString,
    title: Schema.String.check(Schema.isMaxLength(280)),
    recordId: Schema.optional(KinRecordId),
    number: Schema.optional(TrimmedNonEmptyString),
  }),
  scope: Schema.Struct({
    projectKey: Schema.optional(Schema.String),
    projectTitle: Schema.optional(Schema.String),
    clientKey: Schema.optional(Schema.String),
    clientTitle: Schema.optional(Schema.String),
  }),
  since: CanonicalUtcTimestamp,
  measure: Schema.optional(
    Schema.Struct({
      value: Schema.Finite,
      unit: Schema.Literals(["hours", "days", "percent", "count"]),
      threshold: Schema.Finite,
      from: KinPulseThresholdSource,
    }),
  ),
  consequence: Schema.String.check(Schema.isMaxLength(500)),
  actor: KinPulseActor,
  sensitive: Schema.Boolean,
  wake: KinPulseWake,
  handled: Schema.NullOr(KinPulseHandled),
  stage: Schema.optional(Schema.Literals(["heads_up", "draft"])),
  aside: Schema.optional(KinPulseAside),
});

const KinPulseRead = Schema.Struct({
  asOf: CanonicalUtcTimestamp,
  total: NonNegativeInt,
  facts: Schema.Array(KinPulseFact),
  setAside: Schema.optional(Schema.Array(KinPulseAside)),
});

const KinPulseScreenRead = Schema.Struct({
  ...KinPulseRead.fields,
  outline: Schema.optional(KinPulseOutline),
  tasksNeedsYou: Schema.optional(NonNegativeInt),
});

const asOf = "2026-11-22T00:00:00.000Z";

it("reads downgraded list definitions but rejects a raw number field on old clients", () => {
  const list = {
    list: "stock",
    name: "Stock",
    prefix: "ST",
    builtIn: false,
    states: ["open"],
    stateLabels: {},
    defaultState: "open",
    categories: [],
    sensitive: false,
    amount: false,
    currency: "USD",
    archivedAt: null,
    rev: 1,
    open: 0,
  };
  const field = { key: "count", label: "Count", sensitive: false };
  const raw = { lists: [{ ...list, fields: [{ ...field, type: "number" }] }] };
  const legacy = { lists: [{ ...list, fields: [{ ...field, type: "text" }] }] };
  expect(Schema.decodeUnknownSync(CurrentLists)(raw)).toEqual(raw);
  expect(() => Schema.decodeUnknownSync(KinListsResult)(raw)).toThrow();
  expect(Schema.decodeUnknownSync(KinListsResult)(legacy)).toEqual(legacy);
});

it("keeps number goals readable as manual goals", () => {
  const wire = {
    asOf,
    goals: [
      {
        recordId: "goal-1",
        key: "G-1",
        title: "Stock count",
        rev: 1,
        state: "open",
        measure: "manual",
        unit: "units",
        target: 20,
        current: 12,
        expected: 10,
        startsOn: "2026-11-22",
        dueOn: null,
        behind: false,
      },
    ],
  };
  expect(Schema.decodeUnknownSync(KinGoalsResult)(wire)).toEqual(
    Schema.decodeUnknownSync(CurrentGoals)(wire),
  );
});

it("keeps new pulse facts out of an unannounced screen answer", () => {
  const fact = {
    subject: { kind: "record", key: "ST-1", title: "Stock take" },
    scope: {},
    since: asOf,
    consequence: "Stock take needs attention",
    actor: { _tag: "owner" },
    sensitive: false,
    wake: "sweep",
    handled: null,
  };
  const facts = [
    { ...fact, key: "task_late:ST-1", sense: "task_late", family: "work" },
    { ...fact, key: "number_off:ST-1", sense: "number_off", family: "goals" },
    { ...fact, key: "number_stale:ST-1", sense: "number_stale", family: "goals" },
    { ...fact, key: "entry_late:ST-1", sense: "entry_late", family: "work" },
    { ...fact, key: "entry_check:ST-1", sense: "entry_check", family: "work" },
  ];
  const later = new Set<string>(KIN_PULSE_LATER_SENSES);
  const legacyFacts = facts.filter(({ sense }) => !later.has(sense));
  const wire = { asOf, total: legacyFacts.length, facts: legacyFacts };
  expect(
    Schema.decodeUnknownSync(KinPulseScreenRead)(wire).facts.map(({ sense }) => sense),
  ).toEqual(["task_late"]);
  expect(
    Schema.decodeUnknownSync(CurrentPulse)({ asOf, total: facts.length, facts }).facts,
  ).toHaveLength(5);
});
