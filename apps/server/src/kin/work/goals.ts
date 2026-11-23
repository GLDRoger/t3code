import {
  KIN_GOAL_MEASURES,
  KinChatError,
  KinGoalMeasure,
  KinNumberCadence,
  KinNumberDecimal,
  KinNumberDirection,
  KinNumberSource,
  KinRecordId,
  type KinGoal,
  type KinGoalSaveInput,
  type KinMoney,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { KinToolText } from "./leadSchemas.ts";
import * as SqlClient from "effect/sql/SqlClient";

import { NumberSpec, NumberSpecJson } from "../numbers/numberRows.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRecords, requestHashOf } from "./KinRecords.ts";
import { fieldText, isMoney, parseFields, type FieldValue } from "./lists.ts";
import { homeCurrency, recordingCurrency } from "./companyProfile.ts";
import { dayIn, formatMoneyPlain, parseAmount, roundToWhole } from "./money.ts";
import { inList, ownerWriter, theOwner } from "./ownerWork.ts";
import { playbookThreshold } from "./playbooks.ts";
import { countedPayment, endOfDay, ownerZone, startOfDay } from "./recordRows.ts";

/**
 * Company goals: entries of the built-in `goals` list. The server counts each one's progress
 * from Kin's own rows, so a goal only states what it measures, its target and its dates.
 */

/** What `record_create` and `record_update` take for a goal (list goals); due is its date. */
export const GoalInputs = {
  measure: Schema.optional(KinGoalMeasure).annotate({
    description:
      "A goal's measure: revenue_received (money in, from Money), clients_won, tasks_done, or manual (a number you keep current).",
  }),
  target: Schema.optional(KinToolText(60)).annotate({
    description: 'A goal\'s target: money as said for revenue_received ("40 lakh"), else a number.',
  }),
  current: Schema.optional(Schema.NullOr(Schema.Finite)).annotate({
    description: "A manual goal's number now; say where it came from in notes.",
  }),
  unit: Schema.optional(Schema.NullOr(KinToolText(40))).annotate({
    description: 'What a manual goal counts, such as "hires".',
  }),
};
const WatchedNumberInputs = {
  direction: Schema.optional(Schema.NullOr(KinNumberDirection)),
  above: Schema.optional(Schema.NullOr(KinNumberDecimal)),
  below: Schema.optional(Schema.NullOr(KinNumberDecimal)),
  every: Schema.optional(Schema.NullOr(KinNumberCadence)),
  spec: Schema.optional(Schema.NullOr(NumberSpec)),
  source: Schema.optional(Schema.NullOr(KinNumberSource)),
};
const WatchedNumberFields = Schema.Struct(WatchedNumberInputs);
const encodeNumberSpec = Schema.encodeEffect(NumberSpecJson);

export const GOAL_INPUTS = ["measure", "target", "current", "unit"] as const;

const isMeasure = (text: string | null): text is KinGoalMeasure =>
  text !== null && (KIN_GOAL_MEASURES as ReadonlyArray<string>).includes(text);
export const isMoneyMeasure = (measure: KinGoalMeasure) => measure === "revenue_received";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** A target as said: money for revenue, in the company's currency, else a whole count. */
const goalTarget = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  measure: KinGoalMeasure,
  text: string,
) {
  if (isMoneyMeasure(measure)) {
    const home = yield* recordingCurrency(orgId).pipe(
      Effect.catchTags({ SqlError: unavailableOn }),
    );
    const parsed = parseAmount(text, home);
    if ("error" in parsed) return yield* parsed.error;
    return parsed.money;
  }
  const count = Number(text.replace(/[\s,]/g, ""));
  if (!Number.isFinite(count) || count <= 0)
    return yield* invalid(`A ${measure.replaceAll("_", " ")} goal's target is a number.`);
  return String(count);
});

/** The goal fields an agent row or update names, checked; `undefined` leaves one as it is. */
export const goalFields = Effect.fn("KinGoals.fields")(function* (
  orgId: KinOrgId,
  row: {
    readonly measure?: string | undefined;
    readonly target?: string | undefined;
    readonly current?: number | null | undefined;
    readonly unit?: string | null | undefined;
  } & typeof WatchedNumberFields.Type,
  before?: Readonly<Record<string, FieldValue>>,
) {
  const was = before === undefined ? null : fieldText(before, "measure");
  const measure = row.measure ?? was ?? undefined;
  if (row.measure !== undefined && !isMeasure(row.measure))
    return yield* invalid(`A goal measures ${KIN_GOAL_MEASURES.join(", ")}.`);
  // A target kept across a change of measure would be read the other way, money as a count.
  const next = row.measure ?? null;
  if (
    before !== undefined &&
    row.target === undefined &&
    isMeasure(next) &&
    isMoneyMeasure(next) !== (isMeasure(was) && isMoneyMeasure(was))
  )
    return yield* invalid(
      isMoneyMeasure(next)
        ? `A revenue received goal's target is an amount: send the target with the measure, such as target "50,000".`
        : `A ${next.replaceAll("_", " ")} goal's target is a number: send the target with the measure, such as target "12".`,
    );
  if (row.target !== undefined && (measure === undefined || measure === null))
    return yield* invalid("Say what the goal measures with its target.");
  const fields: Record<string, FieldValue | null> = {};
  if (row.measure !== undefined) fields.measure = row.measure;
  if (row.target !== undefined && isMeasure(measure ?? null))
    fields.target = yield* goalTarget(orgId, measure as KinGoalMeasure, row.target);
  if (row.current !== undefined) fields.current = row.current === null ? null : String(row.current);
  if (row.unit !== undefined) fields.unit = row.unit;
  for (const key of ["direction", "above", "below", "every", "source"] as const) {
    if (row[key] !== undefined) fields[key] = row[key];
  }
  if (row.spec !== undefined)
    fields.spec =
      row.spec === null
        ? null
        : yield* encodeNumberSpec(row.spec).pipe(
            Effect.mapError(() =>
              invalid("Use a built-in number or count a list in named states."),
            ),
          );
  return fields;
});

interface GoalRow {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly rev: number;
  readonly state: "open" | "done" | "dropped";
  readonly dueAt: number | null;
  readonly createdAt: number;
  readonly fields: string;
}

/** How far a straight line from start to target has got by `at`. */
const paceAt = (target: number, start: number, end: number | null, at: number) =>
  end === null || at >= end ? target : at <= start ? 0 : (target * (at - start)) / (end - start);

/**
 * Every goal not dropped, with progress counted now. `money` false leaves out goals that count
 * money, for people the owner keeps money from.
 */
// oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- goals are the whole team's by design; `money` hides what members may not see.
export const goalsNow = Effect.fn("KinGoals.now")(function* (
  orgId: KinOrgId,
  at: number,
  options: { readonly money: boolean },
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const rows = yield* sql<GoalRow>`SELECT r.record_id AS "recordId", r.key, r.title, r.rev,
      r.state, r.due_at AS "dueAt", r.created_at AS "createdAt", r.fields_json AS fields
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'goals' AND r.state <> 'dropped'
    ORDER BY r.state = 'done', r.due_at IS NULL, r.due_at, LENGTH(r.key), r.key`;
  const behindPercent = (yield* playbookThreshold(orgId, "goal_behind_percent")).value;
  const goals: Array<KinGoal> = [];
  for (const row of rows) {
    const fields = parseFields(row.fields);
    const measureText = fieldText(fields, "measure");
    if (!isMeasure(measureText)) continue;
    const measure = measureText;
    if (isMoneyMeasure(measure) && !options.money) continue;
    const startsOn = fieldText(fields, "startsOn") ?? dayIn(row.createdAt, zone);
    const start = startOfDay(startsOn, zone);
    const end = row.dueAt;
    const until = Math.min(at, end ?? at);
    const targetField = fields.target;
    const money: KinMoney | undefined =
      targetField !== undefined && isMoney(targetField) ? targetField : undefined;
    const target =
      money !== undefined
        ? money.minor
        : typeof targetField === "string"
          ? Number(targetField)
          : Number.NaN;
    if (!Number.isFinite(target) || target <= 0) continue;
    const current = yield* ownerLevelProgressOf(orgId, measure, {
      start,
      until,
      startsOn,
      untilDay: dayIn(until, zone),
      currency: money?.currency ?? (yield* homeCurrency(orgId)),
      manual: Number(fieldText(fields, "current") ?? 0) || 0,
    });
    const expected = paceAt(target, start, end, at);
    const unit = fieldText(fields, "unit");
    goals.push({
      recordId: KinRecordId.make(row.recordId),
      key: row.key,
      title: row.title,
      rev: row.rev,
      state: row.state,
      measure,
      ...(money === undefined ? {} : { currency: money.currency }),
      ...(unit === null ? {} : { unit }),
      target,
      current,
      expected,
      startsOn,
      dueOn: end === null ? null : dayIn(end, zone),
      behind:
        row.state === "open" &&
        end !== null &&
        at > start &&
        current < target &&
        current < expected * (1 - behindPercent / 100),
    });
  }
  return { goals, behindPercent };
});

export const ownerLevelReceivedByCurrency = Effect.fn("KinGoals.ownerLevelReceivedByCurrency")(
  function* (orgId: KinOrgId, startsOn: string, untilDay: string, currency?: string) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<KinMoney>`SELECT SUM(p.amount_minor) AS minor, p.currency
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND ${countedPayment(sql)} AND p.withheld = 0
      AND r.register_id IN ('invoices', 'receipts')
      AND p.paid_on >= ${startsOn} AND p.paid_on <= ${untilDay}
      ${currency === undefined ? sql`` : sql`AND p.currency = ${currency}`}
    GROUP BY p.currency ORDER BY p.currency`;
  },
);

export const ownerLevelProgressOf = Effect.fn("KinGoals.progress")(function* (
  orgId: KinOrgId,
  measure: KinGoalMeasure,
  period: {
    readonly start: number;
    readonly until: number;
    readonly startsOn: string;
    readonly untilDay: string;
    readonly currency: string;
    readonly manual: number;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  switch (measure) {
    case "manual":
      return period.manual;
    case "revenue_received": {
      const [row] = yield* ownerLevelReceivedByCurrency(
        orgId,
        period.startsOn,
        period.untilDay,
        period.currency,
      );
      return row?.minor ?? 0;
    }
    case "clients_won": {
      const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'clients' AND r.state <> 'dropped'
          AND COALESCE(r.category, 'client') = 'client'
          AND r.created_at >= ${period.start} AND r.created_at <= ${period.until}`;
      return row?.count ?? 0;
    }
    case "tasks_done": {
      const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state = 'done'
          AND r.closed_at >= ${period.start} AND r.closed_at <= ${period.until}`;
      return row?.count ?? 0;
    }
  }
});

/** A goal's figures as a person or an agent reads them: "₹12,00,000 of ₹40,00,000". */
export const goalFigure = (goal: KinGoal, value: number, withUnit = true) =>
  goal.currency === undefined
    ? `${Math.round(value)}${goal.unit === undefined || !withUnit ? "" : ` ${goal.unit}`}`
    : formatMoneyPlain({ minor: roundToWhole(value, goal.currency), currency: goal.currency });

/** One line per goal for a prompt: where it stands against its line. */
export const goalLine = (goal: KinGoal) =>
  [
    `${goal.key} ${goal.title}: ${goalFigure(goal, goal.current, false)} of ${goalFigure(goal, goal.target)}`,
    goal.dueOn === null ? null : `by ${goal.dueOn}`,
    goal.state === "done"
      ? "reached"
      : goal.dueOn === null
        ? null
        : `${goalFigure(goal, goal.expected)} expected by now${goal.behind ? ", behind" : ""}`,
  ]
    .filter((part) => part !== null)
    .join(", ");

/** A failed read of Kin's rows reaches a client as Kin being unavailable, logged here. */
const unavailableOn = (cause: unknown) =>
  Effect.logWarning("Kin goals read failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

const isOwnerOf = Effect.fn("KinGoals.isOwner")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  return yield* theOwner(people, orgId).pipe(
    Effect.as(true),
    Effect.catchTags({ KinChatError: () => Effect.succeed(false) }),
  );
});

/** Goals for a screen: the owner sees every one; anyone else, those that don't count money. */
export const list = Effect.fn("KinGoals.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  if (!people.some((person) => person.orgId === orgId))
    return yield* new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
  const at = yield* Clock.currentTimeMillis;
  const { goals } = yield* goalsNow(orgId, at, { money: yield* isOwnerOf(people, orgId) }).pipe(
    Effect.catchTags({ SqlError: unavailableOn }),
  );
  return { goals, asOf: DateTime.makeUnsafe(at) };
});

/** The owner adds a goal, or changes, reaches or drops one. */
export const save = Effect.fn("KinGoals.save")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinGoalSaveInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const zone = yield* ownerZone(input.orgId);
  if (input.dueOn < input.startsOn) return yield* invalid("A goal's date comes after its start.");
  const fields = {
    ...(yield* goalFields(input.orgId, {
      measure: input.measure,
      target: input.target,
      ...(input.current === undefined ? {} : { current: input.current }),
      ...(input.unit === undefined ? {} : { unit: input.unit }),
    })),
    startsOn: input.startsOn,
  };
  const due = { dueAt: endOfDay(input.dueOn, zone), dueAllDay: true };
  const writer = ownerWriter(person);
  const sensitive = isMoneyMeasure(input.measure);
  const row =
    input.key === undefined
      ? (yield* records.create(input.orgId, writer, {
          list: "goals",
          originKey: `owner:${input.clientRequestId}`,
          requestHash: requestHashOf(input),
          title: input.title,
          owner: { _tag: "person", personId: person.personId },
          fields,
          ...due,
          ...(sensitive ? { sensitive: true } : {}),
          ...(input.state === undefined ? {} : { state: input.state }),
        })).row
      : yield* Effect.gen(function* () {
          yield* inList(input.orgId, input.key!, "goals");
          return yield* records.update(
            input.orgId,
            writer,
            input.key!,
            {
              title: input.title,
              fields,
              ...due,
              ...(sensitive ? { sensitive: true } : {}),
              ...(input.state === undefined ? {} : { state: input.state }),
            },
            input.rev,
          );
        });
  const at = yield* Clock.currentTimeMillis;
  const { goals } = yield* goalsNow(input.orgId, at, { money: true }).pipe(
    Effect.catchTags({ SqlError: unavailableOn }),
  );
  const goal = goals.find((one) => one.key === row.key);
  if (goal !== undefined) return goal;
  // A dropped goal leaves the list; answer with what was saved.
  return {
    recordId: KinRecordId.make(row.recordId),
    key: row.key,
    title: row.title,
    rev: row.rev,
    state: row.state === "done" || row.state === "open" ? row.state : "dropped",
    measure: input.measure,
    target: 0,
    current: 0,
    expected: 0,
    startsOn: input.startsOn,
    dueOn: input.dueOn,
    behind: false,
  } satisfies KinGoal;
});
