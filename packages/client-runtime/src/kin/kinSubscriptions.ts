// @effect-diagnostics globalDate:off - Pure view helpers count renewals for React render, outside an Effect runtime.
import { kinWhenFormat } from "@t3tools/contracts";
import type {
  EnvironmentId,
  KinListDefinition,
  KinListField,
  KinMoney,
  KinMoneyTotals,
  KinOrgId,
  KinRecord,
  KinRecordKey,
  KinWorkUpdateInput,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "../state/runtime.ts";
import { kinEstimate, kinTotalsEstimate, type KinRates } from "./kinCurrency.ts";
import {
  kinCategoryLabel,
  kinFieldText,
  kinListSend,
  kinMinorDigits,
  kinMoneyText,
  kinTotalsLines,
  type KinListContext,
} from "./kinLists.ts";

/**
 * Subscriptions: a list people keep, read as what the company pays for again and again. Kin
 * doesn't fix the list's shape, so this reads what each entry has: an amount, a renewal day, a
 * cycle (its repeat rule, or a field saying monthly or yearly), what it's for and who uses it.
 * Every exact figure stays per currency; a monthly figure from a yearly plan says so.
 */

export const KIN_SUBSCRIPTIONS = {
  loadFailed: "Couldn't load subscriptions",
  askAbout: "About our subscriptions: ",
  title: "Subscriptions",
  renewing: "Renewing in the next 30 days",
  nothingRenewing: "Nothing renews in the next 30 days.",
  active: "Active",
  cancelled: "Cancelled",
  monthly: "A month",
  monthlyNote: "Yearly and quarterly plans counted per month.",
  thisMonth: "Renews this month",
  yearSoFar: "This financial year so far",
  runRate: "Yearly run rate",
  noCycle: "Cycle not set",
  noRenewal: "No renewal day",
  add: "Add a subscription",
  addMessage: "Add a subscription: ",
  cancel: "Mark cancelled",
  undoCancel: "Not cancelled",
  none: {
    title: "No subscriptions yet",
    detail:
      "Tell an agent what you pay for every month or year, with a screenshot or the bill, and it keeps them here.",
  },
  ask: "Ask about subscriptions",
};

/** A Subscriptions list: one the company named so. Null until there is one. */
export const kinSubscriptionsList = (
  lists: ReadonlyArray<KinListDefinition>,
): KinListDefinition | null =>
  lists.find((def) => def.archivedAt === null && def.list === "subscriptions") ??
  lists.find((def) => def.archivedAt === null && /subscription/i.test(def.name)) ??
  null;

/** Months per cycle, or days for an every-N-days rule. */
export type KinCycle = { readonly months: 1 | 3 | 6 | 12 } | { readonly days: number } | null;

const CYCLE_WORDS: ReadonlyArray<readonly [RegExp, KinCycle]> = [
  [/annual|year|yearly|\byr\b|12\s*months?/i, { months: 12 }],
  [/half|6\s*months?|semi/i, { months: 6 }],
  [/quarter|3\s*months?/i, { months: 3 }],
  [/month|monthly|\bmo\b/i, { months: 1 }],
  [/week/i, { days: 7 }],
];

const fieldBy = (def: KinListDefinition, type: KinListField["type"], pattern: RegExp) =>
  def.fields.find(
    (field) =>
      field.retired !== true &&
      field.type === type &&
      (pattern.test(field.key) || pattern.test(field.label)),
  );

/** Which of the list's own fields say the cycle, purpose, user, project and end. */
function kinSubscriptionFields(def: KinListDefinition) {
  return {
    cycle:
      fieldBy(def, "choice", /cycle|billing|plan|frequen|period|interval|renew/i) ??
      fieldBy(def, "text", /cycle|billing|plan|frequen|period|interval/i),
    purpose: fieldBy(def, "text", /for|purpose|use|what|description|note/i),
    user: def.fields.find((field) => field.retired !== true && field.type === "person"),
    project: def.fields.find(
      (field) => field.retired !== true && field.type === "link" && field.link === "projects",
    ),
    ends: fieldBy(def, "date", /end|cancel|until|expir/i),
  };
}

function kinCycleOf(
  record: Pick<KinRecord, "repeat" | "fields">,
  fields: ReturnType<typeof kinSubscriptionFields>,
): KinCycle {
  const rule = record.repeat;
  if (rule !== undefined) {
    if (rule.every === "days") return { days: rule.days };
    return { months: rule.every === "month" ? 1 : rule.every === "quarter" ? 3 : 12 };
  }
  const value = fields.cycle === undefined ? undefined : record.fields?.[fields.cycle.key];
  if (typeof value !== "string") return null;
  return CYCLE_WORDS.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

const cycleLabel = (cycle: KinCycle) =>
  cycle === null
    ? KIN_SUBSCRIPTIONS.noCycle
    : "days" in cycle
      ? cycle.days === 7
        ? "Weekly"
        : `Every ${cycle.days} days`
      : cycle.months === 1
        ? "Monthly"
        : cycle.months === 3
          ? "Quarterly"
          : cycle.months === 6
            ? "Every 6 months"
            : "Yearly";

/** Payments in a year: 12 for monthly, 1 for yearly, 52 for weekly. */
const perYear = (cycle: NonNullable<KinCycle>) =>
  "days" in cycle ? 365 / cycle.days : 12 / cycle.months;

// Days as local calendar days, compared as YYYY-MM-DD.

const pad = (value: number) => String(value).padStart(2, "0");
const dayOfDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const dayOf = (iso: string) => dayOfDate(new Date(iso));
const partsOf = (day: string) => day.split("-").map(Number) as [number, number, number];
const fromParts = (year: number, month: number, day: number) => {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
};

/** `day` moved by `count` cycles, keeping its day of the month where the month has it. */
export function kinCycleStep(day: string, cycle: NonNullable<KinCycle>, count: number): string {
  const [year, month, date] = partsOf(day);
  if ("days" in cycle) {
    const moved = new Date(year, month - 1, date + cycle.days * count);
    return dayOfDate(moved);
  }
  const index = year * 12 + (month - 1) + cycle.months * count;
  return fromParts(Math.floor(index / 12), (index % 12) + 1, date);
}

/** Every renewal day in `[from, to]`, given one renewal day and the cycle. */
export function kinRenewalsBetween(
  anchor: string,
  cycle: NonNullable<KinCycle>,
  from: string,
  to: string,
): ReadonlyArray<string> {
  // Step back to before `from`, then forward; a few hundred steps covers decades of weeks.
  let count = 0;
  while (kinCycleStep(anchor, cycle, count) >= from && count > -2000) count -= 1;
  const days: Array<string> = [];
  for (let step = count; step < count + 2000; step += 1) {
    const day = kinCycleStep(anchor, cycle, step);
    if (day > to) break;
    if (day >= from) days.push(day);
  }
  return days;
}

const shortDay = kinWhenFormat("date");
const longDay = kinWhenFormat("dateYear");
const dayLabel = (day: string, today: string) => {
  const [year, month, date] = partsOf(day);
  const value = new Date(year, month - 1, date);
  if (day === today) return "Today";
  if (day === kinCycleStep(today, { days: 1 }, 1)) return "Tomorrow";
  return (year === partsOf(today)[0] ? shortDay : longDay).format(value);
};

export interface KinSubscriptionRow {
  readonly key: string;
  readonly title: string;
  readonly purpose: string | null;
  readonly cycle: string;
  /** In its own currency, exactly. */
  readonly amount: string | null;
  /** "about ₹1,680" beside a foreign amount. */
  readonly estimate: string | null;
  readonly estimateBasis: string | null;
  /** The next renewal day, YYYY-MM-DD, after today's; null once it has ended or with none. */
  readonly next: string | null;
  /** "Renews 21 Nov", "Ends 30 Nov", "Ended 2 Nov", "No renewal day". */
  readonly when: string;
  /** Who uses it, or the project it's for. */
  readonly who: string | null;
  readonly cancelled: boolean;
  /** Its own repeat rule. Cancelling clears it, or closing the entry would start the next one. */
  readonly repeat: KinRecord["repeat"] | null;
  readonly rev: number;
  readonly accessibilityLabel: string;
}

export interface KinSubscriptionsView {
  readonly active: ReadonlyArray<KinSubscriptionRow>;
  readonly cancelled: ReadonlyArray<KinSubscriptionRow>;
  /** Soonest first: the active ones renewing in the next 30 days. */
  readonly renewing: ReadonlyArray<KinSubscriptionRow>;
  /** Per currency, one line each; each foreign line has its estimate beside it. */
  readonly monthly: ReadonlyArray<KinFigureLine>;
  /** "about ₹x a month in all", only when every currency has a rate. */
  readonly monthlyAll: string | null;
  readonly thisMonth: ReadonlyArray<KinFigureLine>;
  readonly yearSoFar: ReadonlyArray<KinFigureLine>;
  readonly runRate: ReadonlyArray<KinFigureLine>;
  /** Currencies with no rate, for "Set a rate". */
  readonly missingRates: ReadonlyArray<string>;
  /** Entries with no cycle aren't in the monthly figures; say how many. */
  readonly uncounted: number;
  /** "12 active · about ₹24,300 a month": Money's one line. */
  readonly summary: string;
}

export interface KinFigureLine {
  readonly currency: string;
  readonly text: string;
  readonly estimate: string | null;
}

const add = (sums: Map<string, number>, money: KinMoney, times = 1) =>
  sums.set(money.currency, (sums.get(money.currency) ?? 0) + Math.round(money.minor * times));
/** One total per currency, the home currency first. */
const totalsOf = (sums: ReadonlyMap<string, number>, home: string | undefined): KinMoneyTotals =>
  [...sums.entries()]
    .filter(([, minor]) => minor > 0)
    .map(([currency, minor]) => ({ currency, minor }))
    .sort((a, b) =>
      a.currency === home ? -1 : b.currency === home ? 1 : a.currency.localeCompare(b.currency),
    );
const linesOf = (totals: KinMoneyTotals, rates: KinRates | null): ReadonlyArray<KinFigureLine> =>
  totals.map((money) => ({
    currency: money.currency,
    text: kinMoneyText(money),
    estimate: kinEstimate(money, rates)?.text ?? null,
  }));

/**
 * The list's entries as subscriptions. `financialYearStart` is the first day of the year the
 * "so far" figure counts from, such as 2026-04-01.
 */
export function kinSubscriptionsView(
  def: KinListDefinition,
  records: ReadonlyArray<KinRecord>,
  context: KinListContext,
  rates: KinRates | null,
  financialYearStart: string,
): KinSubscriptionsView {
  const fields = kinSubscriptionFields(def);
  const today = dayOfDate(context.now);
  const soon = kinCycleStep(today, { days: 1 }, 30);
  const [year, month] = partsOf(today);
  const monthStart = fromParts(year, month, 1);
  const monthEnd = fromParts(year, month, 31);
  const monthly = new Map<string, number>();
  const runRate = new Map<string, number>();
  const thisMonth = new Map<string, number>();
  const yearSoFar = new Map<string, number>();
  const averaged = new Set<string>();
  let uncounted = 0;
  const rows: Array<KinSubscriptionRow & { readonly sortDay: string }> = [];
  for (const record of records) {
    // A suggestion is no subscription yet: Money lists it to keep.
    if (!record.confirmed) continue;
    const cycle = kinCycleOf(record, fields);
    const cancelled = record.state === "dropped" || record.state === "done";
    const renewal = record.dateAt ?? record.dueAt;
    const anchor = renewal === null || renewal === undefined ? null : dayOf(renewal);
    const endField = fields.ends === undefined ? undefined : record.fields?.[fields.ends.key];
    const endsOn =
      typeof endField === "string" && /^\d{4}-\d{2}-\d{2}$/.test(endField)
        ? endField
        : cancelled
          ? // Cancelled with a renewal still ahead: it runs until then. Otherwise, when it closed.
            anchor !== null && anchor > today
            ? anchor
            : record.closedAt === null
              ? today
              : dayOf(record.closedAt)
          : null;
    // The last day a renewal can fall on: the day it ends, else today for the year so far.
    const lastCharge = endsOn === null ? today : endsOn < today ? endsOn : today;
    const amount = record.amount;
    if (amount !== undefined && cycle !== null && anchor !== null) {
      for (const day of kinRenewalsBetween(anchor, cycle, financialYearStart, lastCharge))
        if (day <= today) add(yearSoFar, amount);
      const monthLast = endsOn !== null && endsOn < monthEnd ? endsOn : monthEnd;
      add(thisMonth, amount, kinRenewalsBetween(anchor, cycle, monthStart, monthLast).length);
    }
    if (amount !== undefined && !cancelled) {
      if (cycle === null) uncounted += 1;
      else {
        add(runRate, amount, perYear(cycle));
        add(monthly, amount, perYear(cycle) / 12);
        if (!Number.isInteger((amount.minor * perYear(cycle)) / 12)) averaged.add(amount.currency);
      }
    }
    const next =
      cycle === null || anchor === null
        ? anchor !== null && anchor > today && !cancelled
          ? anchor
          : null
        : (kinRenewalsBetween(
            anchor,
            cycle,
            kinCycleStep(today, { days: 1 }, 1),
            kinCycleStep(today, { months: 12 }, 2),
          ).find((day) => endsOn === null || day <= endsOn) ?? null);
    const when = cancelled
      ? endsOn !== null && endsOn > today
        ? `Ends ${dayLabel(endsOn, today)}`
        : `Ended ${dayLabel(endsOn ?? today, today)}`
      : next === null
        ? KIN_SUBSCRIPTIONS.noRenewal
        : `Renews ${dayLabel(next, today)}`;
    const purposeValue =
      fields.purpose === undefined ? undefined : record.fields?.[fields.purpose.key];
    const purpose =
      (fields.purpose === undefined ? null : kinFieldText(fields.purpose, purposeValue, context)) ??
      (record.listCategory === undefined ? null : kinCategoryLabel(record.listCategory, def));
    const userText =
      fields.user === undefined
        ? null
        : kinFieldText(fields.user, record.fields?.[fields.user.key], context);
    const projectText =
      record.project?.title ??
      (fields.project === undefined
        ? null
        : kinFieldText(fields.project, record.fields?.[fields.project.key], context));
    const who = [userText, projectText].filter(Boolean).join(" · ") || null;
    const estimate = amount === undefined ? null : kinEstimate(amount, rates);
    const amountText = amount === undefined ? null : kinMoneyText(amount);
    const cycleText = cycleLabel(cycle);
    rows.push({
      key: record.key,
      title: record.title,
      purpose,
      cycle: cycleText,
      amount: amountText,
      estimate: estimate?.text ?? null,
      estimateBasis: estimate?.basis ?? null,
      next: cancelled ? null : next,
      when,
      who,
      cancelled,
      repeat: record.repeat ?? null,
      rev: record.rev,
      sortDay: next ?? endsOn ?? "9999-12-31",
      accessibilityLabel: [
        record.title,
        purpose,
        amountText === null ? null : `${amountText} ${cycleText.toLowerCase()}`,
        estimate?.text,
        when,
        who,
        cancelled ? KIN_SUBSCRIPTIONS.cancelled : null,
      ]
        .filter(Boolean)
        .join(". "),
    });
  }
  const bySoonest = (a: { sortDay: string }, b: { sortDay: string }) =>
    a.sortDay.localeCompare(b.sortDay);
  const strip = ({ sortDay: _sortDay, ...row }: (typeof rows)[number]): KinSubscriptionRow => row;
  const active = rows.filter((row) => !row.cancelled).sort(bySoonest);
  // A plan that doesn't divide evenly into months is averaged, so its currency shows in whole units.
  const monthlyTotals = totalsOf(monthly, rates?.home).map((money) => {
    if (!averaged.has(money.currency)) return money;
    const unit = 10 ** kinMinorDigits(money.currency);
    return { ...money, minor: Math.round(money.minor / unit) * unit };
  });
  const allMonthly = kinTotalsEstimate(monthlyTotals, rates);
  const runRateTotals = totalsOf(runRate, rates?.home);
  const missing = [
    ...new Set([
      ...(kinTotalsEstimate(runRateTotals, rates)?.missing ?? []),
      ...(allMonthly?.missing ?? []),
    ]),
  ];
  const monthlyLine =
    monthlyTotals.length === 0
      ? null
      : (allMonthly?.all?.replace(/ in all$/, "") ?? kinTotalsLines(monthlyTotals).join(" and "));
  return {
    active: active.map(strip),
    cancelled: rows
      .filter((row) => row.cancelled)
      .sort((a, b) => b.sortDay.localeCompare(a.sortDay))
      .map(strip),
    renewing: active.filter((row) => row.next !== null && row.next <= soon).map(strip),
    monthly: linesOf(monthlyTotals, rates),
    monthlyAll: monthlyTotals.length > 1 ? (allMonthly?.all ?? null) : null,
    thisMonth: linesOf(totalsOf(thisMonth, rates?.home), rates),
    yearSoFar: linesOf(totalsOf(yearSoFar, rates?.home), rates),
    runRate: linesOf(runRateTotals, rates),
    missingRates: missing,
    uncounted,
    summary: [`${active.length} active`, monthlyLine === null ? null : `${monthlyLine} a month`]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * The first day of the financial year `now` is in, for a year starting in `startMonth`: April
 * where the host didn't say, as hosts before company years were set.
 */
export const kinFinancialYearStart = (now: Date, startMonth = 4) =>
  `${now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1}-${pad(startMonth)}-01`;

/** The one just marked cancelled, so the notice can put it back with its cycle. */
export interface KinSubscriptionUndo {
  readonly key: string;
  readonly title: string;
  readonly repeat: KinSubscriptionRow["repeat"];
}

/** What Cancel and Undo on a subscription do, the same on every client; each app holds the state. */
export function kinSubscriptionActions<A>(options: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly def: KinListDefinition;
  readonly online: () => boolean;
  readonly update: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: KinWorkUpdateInput;
  }) => Promise<AtomCommandResult<A, unknown>>;
  /** Reads the list again after every answer, refused or not. */
  readonly refresh: () => void;
  readonly set: {
    readonly busy: (key: string | null) => void;
    readonly problem: (problem: string | null) => void;
    readonly undo: (undo: KinSubscriptionUndo | null) => void;
  };
}) {
  const { environmentId, orgId, def, set } = options;
  const setState = async (
    row: KinSubscriptionRow,
    cancel: boolean,
    repeat: KinSubscriptionRow["repeat"] = null,
  ) => {
    set.busy(row.key);
    set.problem(null);
    const outcome = await kinListSend({
      online: options.online,
      send: () =>
        options.update({
          environmentId,
          input: {
            orgId,
            key: row.key as KinRecordKey,
            rev: row.rev,
            state: cancel ? "dropped" : def.defaultState === "dropped" ? "open" : def.defaultState,
            // A cancelled one must not renew itself; undo puts its cycle back.
            ...(cancel && row.repeat !== null ? { repeat: null } : {}),
            ...(!cancel && repeat !== null ? { repeat } : {}),
          },
        }),
    });
    set.busy(null);
    options.refresh();
    if (!outcome.ok) return set.problem(outcome.problem);
    set.undo(cancel ? { key: row.key, title: row.title, repeat: row.repeat } : null);
  };
  return {
    cancellable: def.states.includes("dropped"),
    cancel: (row: KinSubscriptionRow) => setState(row, true),
    restore: (row: KinSubscriptionRow) => setState(row, false),
    /** The notice's Undo: puts back the one it names, if it is still cancelled, with its cycle. */
    undo: (undo: KinSubscriptionUndo, cancelled: ReadonlyArray<KinSubscriptionRow>) => {
      const row = cancelled.find((one) => one.key === undo.key);
      if (row !== undefined) void setState(row, false, undo.repeat);
      set.undo(null);
    },
  };
}
