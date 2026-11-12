// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import type {
  KinFieldValue,
  KinFileRef,
  KinListDefinition,
  KinListField,
  KinListGroupBy,
  KinListId,
  KinListTotals,
  KinListUpdateInput,
  KinMoney,
  KinMoneyTotals,
  KinOrgId,
  KinPayment,
  KinRecord,
  KinRecordDetail,
  KinRecordKey,
  KinRecordState,
  KinRepeatRule,
  KinWorkListInput,
  KinWorkPrincipal,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { formatKinChartValue } from "./kinChart.ts";
import {
  isKinChatError,
  isKinWorkAuthorizationError,
  kinWorkAllDay,
  kinWorkClosed,
  kinWorkDueLabel,
  kinWorkDueText,
  kinWorkName,
  type KinWorkNames,
  type KinWorkRef,
} from "./kinWork.ts";

/**
 * Lists an agent set up in chat, as data: any fields, states and categories, with or without
 * amounts, dates, files and repeats. Nothing here knows what a list is for.
 */

export const KIN_LISTS = {
  title: "Lists",
  search: "Search this list",
  loadFailed: "Couldn't load your lists",
  entriesFailed: "Couldn't load this list",
  none: {
    title: "No lists yet",
    detail:
      "Ask an agent to start tracking something: expenses, invoices, renewals, equipment, anything with a name and a few details.",
  },
  ask: "Ask an agent to start one",
  askMessage: "Start tracking ",
  archived: "Put away",
  showArchived: "Show lists you put away",
  all: "All",
  late: "Overdue",
  noCategory: "No category",
  noClient: "No client",
  anyCategory: "Any category",
  anyClient: "Any client",
  clientFilter: "Client",
  billed: "Billed",
  owed: "Still owed",
  received: "Received",
  paidOut: "Paid",
  groupBy: "Group by",
  group: {
    none: "Nothing",
    category: "Category",
    month: "Month",
    financialYear: "Financial year",
  } satisfies Record<KinListGroupBy, string>,
  rows: "Rows",
  table: "Table",
  entry: {
    amount: "Amount",
    category: "Category",
    client: "Client",
    project: "Project",
    owner: "With",
    repeats: "Repeats",
    notes: "Notes",
    files: "Files",
    history: "History",
    noDate: "No date",
    payments: "Payments",
    noPayments: "No payments yet.",
    recordPayment: "Record a payment",
    payAmount: "Amount received",
    payDay: "Received on",
    payNote: "Note",
    payNotePlaceholder: "Bank transfer, UPI reference…",
    paySave: "Record payment",
    takeBack: "Take back",
    takenBack: "Taken back",
    takeBackTitle: "Take this payment back?",
    takeBackDetail: "It stays in the history and stops counting. The entry is owed again.",
    left: "Still owed",
    received: "Received",
    paidInFull: "Paid in full",
    status: "Status",
    stopRepeat: "Stop repeating",
    askChange: "Ask an agent to change this",
    title: "Title",
    edit: "Edit",
    save: "Save",
    none: "None",
    addFile: "Add a file",
    removeFile: "Remove",
    filesTitle: "Files from your chats",
    filesSearch: "Search files by name",
    filesNone: "No files in your chats yet. Send one to an agent, then add it here.",
    filesNoMatch: "No file with that name.",
    filesFailed: "Couldn't load your files.",
    amountPlaceholder: "40,000 or $120.50",
    retiredField: "No longer used",
    private: "Private. Only you see this.",
    gone: {
      title: "This entry isn't here any more",
      detail: "Open its list to see what there is now.",
    },
  },
  edit: {
    title: "List settings",
    name: "Name",
    states: "What it calls each status",
    fields: "Details",
    retire: "Stop using",
    restore: "Use again",
    retired: "No longer used. Entries keep what they have.",
    categories: "What it calls each category",
    payments: "Entries are paid in parts",
    paymentsDetail: "Each entry keeps its payments and what is still owed, as invoices do.",
    archive: "Put this list away",
    archiveDetail: "It stops taking new entries and leaves this page. Nothing is deleted.",
    restoreList: "Bring this list back",
    builtIn: "This list is part of Kin and can't be changed here.",
    save: "Save",
    cancel: "Cancel",
  },
  onlyOwner: {
    title: "Not available",
    detail: "Lists and money are kept by whoever runs this Kin.",
  },
};

// Money

const moneyUnit = (currency: string) => ({ kind: "money" as const, currency });

/** How many digits follow the point in `currency`: 2 for rupees, 0 for yen. */
const kinMinorDigits = (currency: string) =>
  (formatKinChartValue(moneyUnit(currency), 1, "full", true).split(".")[1] ?? "").length;

/** An exact amount: "₹4,20,000", with paise only when there are some unless `paise` keeps them. */
export const kinMoneyText = (money: KinMoney, paise = false) =>
  formatKinChartValue(moneyUnit(money.currency), money.minor, "full", paise);

/** One line per currency. Currencies are never added together. */
export const kinTotalsLines = (totals: KinMoneyTotals, paise = false): ReadonlyArray<string> =>
  totals.map((money) => kinMoneyText(money, paise));

export const KIN_MONEY_NOTHING = "Nothing";

/** A category as its list labels it, else exactly as it was written and stored. */
export const kinCategoryLabel = (
  category: string,
  def?: Pick<KinListDefinition, "categoryLabels"> | null,
) => def?.categoryLabels?.[category] ?? category;

/** "Today" reads as "today" after a label; a date keeps its capitals. */
const afterLabel = (when: string) =>
  /^(Today|Tomorrow|Yesterday)/.test(when) ? when.charAt(0).toLowerCase() + when.slice(1) : when;

/** Totals in a sentence: "₹4,20,000 and $13", or "Nothing". */
export const kinTotalsText = (totals: KinMoneyTotals, nothing = KIN_MONEY_NOTHING) =>
  totals.length === 0 ? nothing : kinTotalsLines(totals).join(" and ");

const SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/₹|\brs\.?(?=\s|\d|$)/i, "INR"],
  [/\$/, "USD"],
  [/€/, "EUR"],
  [/£/, "GBP"],
];

/**
 * An amount with the currency it names ("$120.50", "EUR 40", "₹4,200"), else in `fallback`.
 * Null when it isn't an amount, is zero, or names two currencies.
 */
export function kinParseMoney(text: string, fallback: string): KinMoney | null {
  const named = new Set<string>();
  let rest = text;
  for (const [pattern, code] of SYMBOLS)
    if (pattern.test(rest)) {
      named.add(code);
      rest = rest.replace(new RegExp(pattern.source, `${pattern.flags}g`), " ");
    }
  rest = rest.replace(/\b[A-Za-z]{3}\b/g, (word) => {
    named.add(word.toUpperCase());
    return " ";
  });
  if (named.size > 1) return null;
  const currency = [...named][0] ?? fallback;
  try {
    return kinParseAmount(rest, currency);
  } catch {
    return null;
  }
}

/** What someone typed as an amount, in minor units; null when it isn't one or is zero. */
export function kinParseAmount(text: string, currency: string): KinMoney | null {
  const digits = kinMinorDigits(currency);
  const cleaned = text.replace(/[\s,₹$€£]/g, "");
  const found = /^(\d{1,13})(?:\.(\d+))?$/.exec(cleaned);
  if (found === null) return null;
  const fraction = found[2] ?? "";
  if (fraction.length > digits) return null;
  const minor = Number(found[1]) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  return minor > 0 && Number.isSafeInteger(minor) ? { minor, currency } : null;
}

// Periods

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const pad = (value: number) => String(value).padStart(2, "0");

/** "November 2026" for `2026-11`. */
export function kinMonthLabel(month: string, short = false): string {
  const name = MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
  return `${short ? name.slice(0, 3) : name} ${month.slice(0, 4)}`;
}

/** "FY 2026–27" for `FY2026-27`. */
export const kinFinancialYearLabel = (year: string) => `FY ${year.slice(2, 6)}–${year.slice(7)}`;

export interface KinPeriod {
  readonly from: string;
  readonly to: string;
}

/** A month's first and last day. */
export function kinMonthPeriod(month: string): KinPeriod {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

/** April to March. */
export function kinFinancialYearPeriod(year: string): KinPeriod {
  const start = Number(year.slice(2, 6));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayMonthFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayMonthYearFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const localDay = (day: string) => {
  const found = DAY.exec(day);
  return found === null ? null : new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3]));
};

/** A period in words: a whole month or financial year by name, anything else by its days. */
export function kinPeriodLabel(period: KinPeriod): string {
  const month = period.from.slice(0, 7);
  const whole = kinMonthPeriod(month);
  if (whole.from === period.from && whole.to === period.to) return kinMonthLabel(month);
  if (period.from.endsWith("-04-01") && period.to.endsWith("-03-31")) {
    const start = Number(period.from.slice(0, 4));
    if (Number(period.to.slice(0, 4)) === start + 1)
      return kinFinancialYearLabel(`FY${start}-${String(start + 1).slice(2)}`);
  }
  const from = localDay(period.from);
  const to = localDay(period.to);
  return from === null || to === null
    ? `${period.from} to ${period.to}`
    : `${dayMonthFormat.format(from)} to ${dayMonthYearFormat.format(to)}`;
}

// Definitions

const STATE_NAMES: Record<KinRecordState, string> = {
  open: "Open",
  doing: "Doing",
  waiting: "Waiting",
  done: "Done",
  dropped: "Dropped",
};

/** What a list calls a state, or the plain word when it never renamed it. */
export const kinListStateLabel = (
  def: Pick<KinListDefinition, "stateLabels"> | null,
  state: KinRecordState,
) => def?.stateLabels[state] ?? STATE_NAMES[state];

export interface KinListIndexRow {
  readonly list: KinListId;
  readonly name: string;
  /** "12 open", "Nothing open", or what it is when put away. */
  readonly line: string;
  readonly archived: boolean;
  readonly amount: boolean;
}

/** The lists people defined, by name; Work and the clients directory have screens of their own. */
export function kinListsIndex(lists: ReadonlyArray<KinListDefinition>): {
  readonly active: ReadonlyArray<KinListIndexRow>;
  readonly archived: ReadonlyArray<KinListIndexRow>;
} {
  const rows = lists
    .filter((def) => !def.builtIn)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((def) => ({
      list: def.list,
      name: def.name,
      line:
        def.archivedAt !== null
          ? KIN_LISTS.archived
          : def.open === 0
            ? "Nothing open"
            : `${def.open} open`,
      archived: def.archivedAt !== null,
      amount: def.amount,
    }));
  return {
    active: rows.filter((row) => !row.archived),
    archived: rows.filter((row) => row.archived),
  };
}

// Filters

export type KinListShow = "all" | "open" | KinRecordState;

export interface KinListFilter {
  readonly text: string;
  readonly show: KinListShow;
  /** Past due and not closed. */
  readonly late: boolean;
  readonly category: string | null;
  /** Only entries with no category; `category` is null with it. */
  readonly noCategory: boolean;
  /** Only entries with no client; `party` is null with it. */
  readonly noParty: boolean;
  /** The entry's own date, first and last day. */
  readonly period: KinPeriod | null;
  /** A payment came in between these days. */
  readonly paid: KinPeriod | null;
  readonly party: KinWorkRef | null;
  readonly project: KinWorkRef | null;
  readonly groupBy: KinListGroupBy;
}

export const KIN_LIST_DEFAULT_FILTER: KinListFilter = {
  text: "",
  show: "all",
  late: false,
  category: null,
  noCategory: false,
  noParty: false,
  period: null,
  paid: null,
  party: null,
  project: null,
  groupBy: "none",
};

const samePeriod = (a: KinPeriod | null, b: KinPeriod | null) =>
  a?.from === b?.from && a?.to === b?.to;

/** Whether two filters ask the host for the same rows. */
export const kinListSameFilter = (a: KinListFilter, b: KinListFilter) =>
  a.text.trim() === b.text.trim() &&
  a.show === b.show &&
  a.late === b.late &&
  a.category === b.category &&
  a.noCategory === b.noCategory &&
  a.noParty === b.noParty &&
  samePeriod(a.period, b.period) &&
  samePeriod(a.paid, b.paid) &&
  a.party?.key === b.party?.key &&
  a.project?.key === b.project?.key &&
  a.groupBy === b.groupBy;

export function kinListQuery(
  orgId: KinOrgId,
  list: KinListId,
  filter: KinListFilter,
): KinWorkListInput {
  const text = filter.text.trim();
  return {
    orgId,
    list,
    ...(filter.show === "all"
      ? {}
      : filter.show === "open"
        ? { open: true }
        : { states: [filter.show] }),
    ...(filter.late ? { late: true } : {}),
    ...(filter.noCategory
      ? { listCategory: null }
      : filter.category === null
        ? {}
        : { listCategory: filter.category as NonNullable<KinWorkListInput["listCategory"]> }),
    ...(filter.period === null ? {} : { dateFrom: filter.period.from, dateTo: filter.period.to }),
    ...(filter.paid === null ? {} : { paidFrom: filter.paid.from, paidTo: filter.paid.to }),
    ...(filter.noParty
      ? { party: null }
      : filter.party === null
        ? {}
        : { party: filter.party.key }),
    ...(filter.project === null ? {} : { project: filter.project.key }),
    ...(text === "" ? {} : { text }),
    totalsBy: filter.groupBy,
  };
}

export interface KinListChip {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly filter: KinListFilter;
}

/** Every status the list uses, and what is overdue when its entries fall due. */
export function kinListChips(
  def: KinListDefinition,
  filter: KinListFilter,
): ReadonlyArray<KinListChip> {
  const plain = !filter.late;
  return [
    {
      id: "all",
      label: KIN_LISTS.all,
      selected: plain && (filter.show === "all" || filter.show === "open"),
      filter: { ...filter, show: "all", late: false },
    },
    ...def.states.map((state) => ({
      id: state,
      label: kinListStateLabel(def, state),
      selected: plain && filter.show === state,
      filter: { ...filter, show: state, late: false },
    })),
    ...(def.dueLabel === undefined
      ? []
      : [
          {
            id: "late",
            label: KIN_LISTS.late,
            selected: filter.late,
            filter: { ...filter, show: "all" as const, late: true },
          },
        ]),
  ];
}

export interface KinListNarrowing {
  readonly id: string;
  readonly label: string;
  /** The filter without it. */
  readonly cleared: KinListFilter;
}

/** What the list is narrowed to beyond its status, each with its way back. */
export function kinListNarrowings(
  filter: KinListFilter,
  def?: KinListDefinition | null,
): ReadonlyArray<KinListNarrowing> {
  return [
    ...(filter.noCategory
      ? [
          {
            id: "category",
            label: KIN_LISTS.noCategory,
            cleared: { ...filter, noCategory: false },
          },
        ]
      : filter.category === null
        ? []
        : [
            {
              id: "category",
              label: kinCategoryLabel(filter.category, def),
              cleared: { ...filter, category: null },
            },
          ]),
    ...(filter.period === null
      ? []
      : [
          {
            id: "period",
            label: kinPeriodLabel(filter.period),
            cleared: { ...filter, period: null },
          },
        ]),
    ...(filter.paid === null
      ? []
      : [
          {
            id: "paid",
            label: `Paid in ${kinPeriodLabel(filter.paid)}`,
            cleared: { ...filter, paid: null },
          },
        ]),
    ...(filter.noParty
      ? [{ id: "party", label: KIN_LISTS.noClient, cleared: { ...filter, noParty: false } }]
      : filter.party === null
        ? []
        : [{ id: "party", label: filter.party.title, cleared: { ...filter, party: null } }]),
    ...(filter.project === null
      ? []
      : [{ id: "project", label: filter.project.title, cleared: { ...filter, project: null } }]),
  ];
}

/** Which ways this list's totals can split: only by what it has. */
export const kinListGroupings = (def: KinListDefinition): ReadonlyArray<KinListGroupBy> => [
  "none",
  ...(def.categories.length > 0 ? (["category"] as const) : []),
  ...(def.dateLabel !== undefined || def.dueLabel !== undefined
    ? (["month", "financialYear"] as const)
    : []),
];

/** One figure over a list: "Still owed" with a line per currency. */
export interface KinListFigure {
  readonly id: "total" | "owed" | "received";
  /** Null for the only figure of a list that isn't paid over time: it needs no name. */
  readonly label: string | null;
  readonly lines: ReadonlyArray<string>;
}

type Sums = Pick<KinListTotals, "total" | "owed" | "received">;

/**
 * The figures a filter's sums make, the one the filter is about first: what was received in a
 * paid window, else what is still owed where entries are paid over time, then what was billed.
 */
function figuresOf(def: KinListDefinition, sums: Sums): ReadonlyArray<KinListFigure> {
  if (!def.amount) return [];
  const some = (totals: KinMoneyTotals) =>
    totals.length === 0 ? [KIN_MONEY_NOTHING] : kinTotalsLines(totals);
  const billed = { id: "total" as const, label: KIN_LISTS.billed, lines: some(sums.total) };
  if (sums.received !== undefined)
    return [
      {
        id: "received",
        label: def.list === "invoices" ? KIN_LISTS.received : KIN_LISTS.paidOut,
        lines: some(sums.received),
      },
      billed,
    ];
  if (sums.owed !== undefined)
    return [{ id: "owed", label: KIN_LISTS.owed, lines: some(sums.owed) }, billed];
  return [{ id: "total", label: null, lines: kinTotalsLines(sums.total) }];
}

export interface KinListGroupView {
  readonly key: string;
  readonly label: string;
  /** "14 entries". */
  readonly count: string;
  /** The group's leading figure, one line per currency; empty in a list without amounts. */
  readonly totals: ReadonlyArray<string>;
  /** "₹1,00,000 billed", under a leading figure that is something else. */
  readonly billed: string | null;
  /** The list narrowed to this group; null for a group that can't be asked for on its own. */
  readonly narrowed: KinListFilter | null;
  readonly selected: boolean;
}

const countText = (count: number) => (count === 1 ? "1 entry" : `${count} entries`);

export interface KinListHeaderView {
  /** What the filter's entries add up to, the leading figure first; empty without amounts. */
  readonly figures: ReadonlyArray<KinListFigure>;
  /** The full amounts, one line per currency; empty without amounts. */
  readonly totals: ReadonlyArray<string>;
  readonly count: string | null;
  readonly groups: ReadonlyArray<KinListGroupView>;
}

/** The figures over a list: exact sums of every match, and the same split by group. */
export function kinListHeader(
  def: KinListDefinition,
  filter: KinListFilter,
  totals: KinListTotals | null,
  total: number | null,
): KinListHeaderView {
  const groups = (totals?.groups ?? []).map((group): KinListGroupView => {
    const figures = figuresOf(def, group);
    const base = {
      count: countText(group.count),
      totals: figures[0]?.lines ?? [],
      billed:
        figures.length > 1 && group.total.length > 0
          ? `${kinTotalsText(group.total)} ${KIN_LISTS.billed.toLowerCase()}`
          : null,
    };
    if (filter.groupBy === "category") {
      const selected =
        group.group === null
          ? filter.noCategory
          : !filter.noCategory && filter.category === group.group;
      return {
        ...base,
        key: group.group ?? "",
        label: group.group === null ? KIN_LISTS.noCategory : kinCategoryLabel(group.group, def),
        narrowed:
          group.group === null
            ? { ...filter, category: null, noCategory: !selected }
            : { ...filter, noCategory: false, category: selected ? null : group.group },
        selected,
      };
    }
    const period =
      group.group === null
        ? null
        : filter.groupBy === "month"
          ? kinMonthPeriod(group.group)
          : kinFinancialYearPeriod(group.group);
    const selected = period !== null && samePeriod(filter.period, period);
    return {
      ...base,
      key: group.group ?? "",
      label:
        group.group === null
          ? KIN_LISTS.entry.noDate
          : filter.groupBy === "month"
            ? kinMonthLabel(group.group)
            : kinFinancialYearLabel(group.group),
      narrowed: period === null ? null : { ...filter, period: selected ? null : period },
      selected,
    };
  });
  return {
    figures: totals === null ? [] : figuresOf(def, totals),
    totals: def.amount && totals !== null ? kinTotalsLines(totals.total) : [],
    count: total === null ? null : countText(total),
    // Periods read newest first; the host sends them oldest first.
    groups: filter.groupBy === "category" ? groups : [...groups].reverse(),
  };
}

/** "Showing 50 of 132", once there is more than one page. */
export const kinListFooter = (shown: number, total: number | null, more: boolean) =>
  !more ? null : total === null ? `Showing the first ${shown}` : `Showing ${shown} of ${total}`;

export function kinListNothing(
  def: KinListDefinition,
  filter: KinListFilter,
): { readonly title: string; readonly detail: string } {
  const narrowed =
    filter.text.trim() !== "" ||
    filter.show !== "all" ||
    filter.late ||
    kinListNarrowings(filter).length > 0;
  return narrowed
    ? { title: "Nothing matches", detail: "Try another status, or clear what it is narrowed to." }
    : {
        title: `Nothing in ${def.name} yet`,
        detail: "Tell an agent what to add, in a message or with a photo or file.",
      };
}

// Values

export interface KinListContext {
  readonly names: KinWorkNames;
  /** Clients and projects by record id, which is how a link field stores one. */
  readonly refs: ReadonlyMap<string, KinWorkRef>;
  readonly now: Date;
}

const isMoney = (value: KinFieldValue): value is KinMoney =>
  typeof value === "object" && !Array.isArray(value) && "currency" in value;
const isList = (value: KinFieldValue): value is ReadonlyArray<string> => Array.isArray(value);

const principalOf = (value: string): KinWorkPrincipal | null => {
  const at = value.indexOf(":");
  const id = value.slice(at + 1);
  if (at < 0 || id === "") return null;
  // The host stores a person field as `person:<id>` or `agent:<id>`.
  return value.startsWith("agent:")
    ? ({ _tag: "agent", agentId: id } as KinWorkPrincipal)
    : value.startsWith("person:")
      ? ({ _tag: "person", personId: id } as KinWorkPrincipal)
      : null;
};

const dayText = (day: string, now: Date) => (DAY.test(day) ? kinWorkDueLabel(day, now) : day);

/** A field's value as its type reads: a name, a day, an amount, how many files. */
export function kinFieldText(
  field: Pick<KinListField, "type">,
  value: KinFieldValue | undefined,
  context: KinListContext,
): string | null {
  if (value === undefined) return null;
  if (isMoney(value)) return kinMoneyText(value, true);
  if (isList(value)) {
    if (value.length === 0) return null;
    return field.type === "file"
      ? value.length === 1
        ? "1 file"
        : `${value.length} files`
      : value.join(", ");
  }
  if (value.trim() === "") return null;
  switch (field.type) {
    case "date":
      return dayText(value, context.now);
    case "person": {
      const who = principalOf(value);
      return who === null ? value : kinWorkName(who, context.names);
    }
    case "link":
      return context.refs.get(value)?.title ?? "Something that isn't here any more";
    default:
      return value;
  }
}

const kinRepeatText = (rule: KinRepeatRule): string =>
  rule.every === "days"
    ? rule.days === 1
      ? "Every day"
      : rule.days === 7
        ? "Every week"
        : `Every ${rule.days} days`
    : `Every ${rule.every}`;

const whenText = (
  at: string | null | undefined,
  allDay: boolean,
  names: KinWorkNames,
  now: Date,
): string | null => {
  if (at === null || at === undefined) return null;
  const text = kinWorkDueText({ dueAt: at, dueAllDay: allDay }, names, now);
  return text === null ? null : text.charAt(0).toUpperCase() + text.slice(1);
};

// Rows

export interface KinListColumn {
  readonly id: string;
  readonly label: string;
  /** Amounts line up on the right. */
  readonly numeric: boolean;
}

export interface KinListRowView {
  readonly key: KinRecordKey;
  readonly title: string;
  readonly state: KinRecordState;
  readonly stateLabel: string;
  readonly closed: boolean;
  readonly late: boolean;
  /** An agent picked it up on its own and nobody has kept it. */
  readonly suggested: boolean;
  /** "₹1,00,000.00"; null without one. */
  readonly amount: string | null;
  /** "₹60,000.00 still owed" on a part-paid entry. */
  readonly owed: string | null;
  /** "EXP-3 · Travel · 4 Nov · Acme". */
  readonly line: string;
  readonly accessibilityLabel: string;
  /** What each column of the table shows, by column id; absent is empty. */
  readonly cells: Readonly<Record<string, string>>;
}

/** The table's columns: what the definition has, in the order a person reads an entry. */
export function kinListColumns(
  def: KinListDefinition,
  records: ReadonlyArray<KinRecord>,
): ReadonlyArray<KinListColumn> {
  const text = (id: string, label: string): KinListColumn => ({ id, label, numeric: false });
  return [
    text("title", "Entry"),
    text("state", KIN_LISTS.entry.status),
    ...(def.categories.length > 0 ? [text("category", KIN_LISTS.entry.category)] : []),
    ...(def.dateLabel === undefined ? [] : [text("date", def.dateLabel)]),
    ...(def.dueLabel === undefined ? [] : [text("due", def.dueLabel)]),
    ...(records.some((record) => record.party !== undefined)
      ? [text("party", KIN_LISTS.entry.client)]
      : []),
    ...def.fields
      .filter((field) => field.retired !== true)
      .map((field) => ({
        id: `field:${field.key}`,
        label: field.label,
        numeric: field.type === "money",
      })),
    ...(def.amount ? [{ id: "amount", label: KIN_LISTS.entry.amount, numeric: true }] : []),
    ...(records.some((record) => record.balance !== undefined)
      ? [{ id: "owed", label: KIN_LISTS.entry.left, numeric: true }]
      : []),
  ];
}

export function kinListRow(
  record: KinRecord,
  def: KinListDefinition | null,
  context: KinListContext,
  /** What the list around the row already says. */
  within?: { readonly party?: KinRecordKey | null; readonly list?: boolean },
): KinListRowView {
  const { names, now } = context;
  const closed = kinWorkClosed(record.state);
  const stateLabel = kinListStateLabel(def, record.state);
  const date = whenText(record.dateAt, record.dateAllDay ?? true, names, now);
  const due = whenText(record.dueAt, record.dueAllDay, names, now);
  const amount = record.amount === undefined ? null : kinMoneyText(record.amount);
  const partPaid =
    record.balance !== undefined &&
    record.amount !== undefined &&
    record.balance.minor > 0 &&
    record.balance.minor < record.amount.minor;
  const owed = partPaid ? `${kinMoneyText(record.balance!)} still owed` : null;
  const party =
    record.party === undefined || record.party.key === within?.party ? null : record.party.title;
  const dueLine = due === null || closed ? null : `${def?.dueLabel ?? "Due"} ${afterLabel(due)}`;
  const parts = [
    record.key,
    within?.list === false && def !== null ? def.name : null,
    record.listCategory === undefined ? null : kinCategoryLabel(record.listCategory, def),
    stateLabel,
    date,
    dueLine,
    party,
    record.repeat === undefined ? null : kinRepeatText(record.repeat).toLowerCase(),
    record.confirmed || closed ? null : "Suggested",
  ].filter((part) => part !== null);
  const cells: Record<string, string> = {
    title: record.title,
    state: stateLabel,
    ...(record.listCategory === undefined
      ? {}
      : { category: kinCategoryLabel(record.listCategory, def) }),
    ...(date === null ? {} : { date }),
    ...(due === null ? {} : { due }),
    ...(record.party === undefined ? {} : { party: record.party.title }),
    ...(record.amount === undefined ? {} : { amount: kinMoneyText(record.amount, true) }),
    ...(record.balance === undefined ? {} : { owed: kinMoneyText(record.balance, true) }),
  };
  for (const field of def?.fields ?? []) {
    const shown = kinFieldText(field, record.fields?.[field.key], context);
    if (shown !== null) cells[`field:${field.key}`] = shown;
  }
  return {
    key: record.key,
    title: record.title,
    state: record.state,
    stateLabel,
    closed,
    late: record.late,
    suggested: !record.confirmed && !closed,
    amount,
    owed,
    line: parts.join(" · "),
    accessibilityLabel: [
      record.title,
      amount,
      owed,
      ...parts.slice(1),
      record.late ? KIN_LISTS.late : null,
    ]
      .filter((part) => part !== null)
      .join(". "),
    cells,
  };
}

// One entry

export interface KinListFactView {
  readonly id: "category" | "party" | "project" | "owner";
  readonly label: string;
  /** Null when the entry has none. */
  readonly value: string | null;
  /** The client or project it opens. */
  readonly opens: KinRecordKey | null;
  /** A category's choices as stored, with how each reads; empty for anything else. */
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** What it holds now, as the choice it is: a category as stored, a client's or project's key. */
  readonly current: string | null;
}

export interface KinListFieldView {
  readonly key: string;
  readonly label: string;
  readonly type: KinListField["type"];
  /** Null when the entry has nothing in it. */
  readonly text: string | null;
  /** As stored; null with nothing in it. */
  readonly value: KinFieldValue | null;
  /** What a text or amount field starts an edit with. */
  readonly draft: string;
  readonly choices: ReadonlyArray<string>;
  readonly link: "clients" | "projects" | null;
  readonly private: boolean;
  readonly retired: boolean;
  /** A file field's files, to open. */
  readonly files: ReadonlyArray<KinFileRef>;
  /** A link field's client or project, to open. */
  readonly opens: { readonly list: "clients" | "projects"; readonly key: KinRecordKey } | null;
}

export interface KinPaymentView {
  readonly paymentId: string;
  readonly amount: string;
  /** "Thu 5 Nov". */
  readonly when: string;
  readonly note: string | null;
  readonly voided: boolean;
}

export interface KinListEntryView {
  /** "EXP-31 · Expenses". */
  readonly heading: string;
  readonly state: KinRecordState;
  readonly stateLabel: string;
  readonly closed: boolean;
  readonly late: boolean;
  readonly amount: string | null;
  /** Null in a list without amounts. `received` is what payments already cover. */
  readonly amountEdit: {
    readonly draft: string;
    readonly currency: string;
    readonly received: KinMoney | null;
  } | null;
  /** Entries that take payments: what is still owed and what came in. */
  readonly balance: {
    readonly left: KinMoney;
    readonly leftText: string;
    readonly receivedText: string;
    /** "Received" on money owed to us, "Paid" on money we owe. */
    readonly receivedLabel: string;
    readonly settled: boolean;
  } | null;
  readonly facts: ReadonlyArray<KinListFactView>;
  readonly fields: ReadonlyArray<KinListFieldView>;
  /** Files no field of the list holds any more. */
  readonly otherFiles: ReadonlyArray<KinFileRef>;
  readonly payments: ReadonlyArray<KinPaymentView>;
  /** Every status the list uses, to move the entry to. */
  readonly states: ReadonlyArray<{
    readonly state: KinRecordState;
    readonly label: string;
    readonly current: boolean;
  }>;
  /** The one tap that finishes it: "Mark paid". Null once closed, or in a list that never is. */
  readonly finish: {
    readonly label: string;
    /** Finishing is receiving what is left, so the figures stay exact. */
    readonly pays: KinMoney | null;
  } | null;
  readonly dueLabel: string | null;
  readonly dateLabel: string | null;
  /** All-day dates as `YYYY-MM-DD`, for a picker; null with none or a timed one. */
  readonly dueDay: string | null;
  readonly dateDay: string | null;
  readonly due: string | null;
  readonly date: string | null;
  readonly repeat: string | null;
}

/** An entry of any list, with every field read by its type. `def` is null until lists are read. */
export function kinListEntryView(
  item: KinRecordDetail,
  def: KinListDefinition | null,
  context: KinListContext,
): KinListEntryView {
  const { names, now } = context;
  const closed = kinWorkClosed(item.state);
  const filesById = new Map((item.files ?? []).map((file) => [file.attachmentId, file]));
  const held = new Set<string>();
  const fields = (def?.fields ?? []).flatMap((field): ReadonlyArray<KinListFieldView> => {
    const value = item.fields?.[field.key];
    const ids = field.type === "file" && value !== undefined && isList(value) ? value : [];
    const files = ids.flatMap((id) => {
      const file = filesById.get(id);
      if (file !== undefined) held.add(id);
      return file === undefined ? [] : [file];
    });
    const text = kinFieldText(field, value, context);
    // A field nobody uses any more only shows where an entry still has something in it.
    if (field.retired === true && text === null) return [];
    const link =
      field.type === "link" && typeof value === "string" ? context.refs.get(value) : undefined;
    return [
      {
        key: field.key,
        label: field.label,
        type: field.type,
        text,
        value: value === undefined || text === null ? null : value,
        draft:
          value === undefined
            ? ""
            : isMoney(value)
              ? kinMoneyDraft(value, def?.currency ?? value.currency)
              : typeof value === "string"
                ? value
                : "",
        choices: field.choices ?? [],
        link: field.type === "link" ? (field.link ?? "clients") : null,
        private: field.sensitive,
        retired: field.retired === true,
        files,
        opens:
          link === undefined
            ? null
            : { list: field.link === "projects" ? "projects" : "clients", key: link.key },
      },
    ];
  });
  const date = whenText(item.dateAt, item.dateAllDay ?? true, names, now);
  const due = whenText(item.dueAt, item.dueAllDay, names, now);
  const categories = [
    ...(def?.categories ?? []),
    ...(item.listCategory === undefined || def?.categories.includes(item.listCategory) === true
      ? []
      : [item.listCategory]),
  ];
  // Every list entry can have a category, a client and a project, so each has its row to set.
  const facts: Array<KinListFactView> = [
    ...(categories.length === 0
      ? []
      : [
          {
            id: "category" as const,
            label: KIN_LISTS.entry.category,
            value:
              item.listCategory === undefined ? null : kinCategoryLabel(item.listCategory, def),
            opens: null,
            choices: categories.map((value) => ({ value, label: kinCategoryLabel(value, def) })),
            current: item.listCategory ?? null,
          },
        ]),
    {
      id: "party",
      label: KIN_LISTS.entry.client,
      value: item.party?.title ?? null,
      opens: item.party?.key ?? null,
      choices: [],
      current: item.party?.key ?? null,
    },
    {
      id: "project",
      label: KIN_LISTS.entry.project,
      value: item.project?.title ?? null,
      opens: item.project?.key ?? null,
      choices: [],
      current: item.project?.key ?? null,
    },
    {
      id: "owner",
      label: KIN_LISTS.entry.owner,
      value: kinWorkName(item.owner, names),
      opens: null,
      choices: [],
      current: null,
    },
  ];
  const received =
    item.balance === undefined || item.amount === undefined
      ? null
      : { minor: item.amount.minor - item.balance.minor, currency: item.amount.currency };
  const doneLabel = kinListStateLabel(def, "done");
  const canFinish = !closed && (def === null || def.states.includes("done"));
  return {
    heading: def === null ? item.key : `${item.key} · ${def.name}`,
    state: item.state,
    stateLabel: kinListStateLabel(def, item.state),
    closed,
    late: item.late,
    amount: item.amount === undefined ? null : kinMoneyText(item.amount, true),
    amountEdit:
      def?.amount === true || item.amount !== undefined
        ? {
            draft:
              item.amount === undefined
                ? ""
                : kinMoneyDraft(item.amount, def?.currency ?? item.amount.currency),
            currency: item.amount?.currency ?? def?.currency ?? "INR",
            received: received !== null && received.minor > 0 ? received : null,
          }
        : null,
    balance:
      item.balance === undefined || received === null
        ? null
        : {
            left: item.balance,
            leftText: kinMoneyText(item.balance, true),
            receivedText: kinMoneyText(received, true),
            receivedLabel: item.list === "invoices" ? KIN_LISTS.received : KIN_LISTS.paidOut,
            settled: item.balance.minor === 0,
          },
    facts,
    fields,
    otherFiles: (item.files ?? []).filter((file) => !held.has(file.attachmentId)),
    payments: (item.payments ?? []).map((payment: KinPayment) => ({
      paymentId: payment.paymentId,
      amount: kinMoneyText(payment.amount, true),
      when: dayText(payment.paidOn, now),
      note: payment.note.trim() === "" ? null : payment.note.trim(),
      voided: payment.voidedAt !== null,
    })),
    states: (def?.states ?? [item.state]).map((state) => ({
      state,
      label: kinListStateLabel(def, state),
      current: state === item.state,
    })),
    finish: canFinish
      ? {
          label: `Mark ${doneLabel.toLowerCase()}`,
          pays: item.balance !== undefined && item.balance.minor > 0 ? item.balance : null,
        }
      : null,
    dueLabel: def === null ? (item.dueAt === null ? null : "Due") : (def.dueLabel ?? null),
    dateLabel: def === null ? (item.dateAt === undefined ? null : "Date") : (def.dateLabel ?? null),
    dueDay: kinWorkAllDay(item.dueAt, item.dueAllDay, names),
    dateDay: kinWorkAllDay(item.dateAt ?? null, item.dateAllDay ?? true, names),
    due,
    date,
    repeat: item.repeat === undefined ? null : kinRepeatText(item.repeat),
  };
}

// Changes

/** An amount as someone would type it back: "50000.50", with its code when it isn't the list's. */
export function kinMoneyDraft(money: KinMoney, listCurrency: string): string {
  const digits = kinMinorDigits(money.currency);
  const unit = 10 ** digits;
  const whole = Math.floor(money.minor / unit);
  const part = money.minor % unit;
  const number = part === 0 ? String(whole) : `${whole}.${String(part).padStart(digits, "0")}`;
  return money.currency === listCurrency ? number : `${money.currency} ${number}`;
}

/** How a person or agent is stored in a person field. */
export const kinPrincipalValue = (who: KinWorkPrincipal) =>
  who._tag === "agent" ? `agent:${who.agentId}` : `person:${who.personId}`;

type Checked<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: string };

const AMOUNT_PROBLEM = "Enter an amount, like 40,000 or $120.50.";

/** An edited amount as the host takes it (null clears it), or why it can't be saved. */
export function kinAmountCheck(
  text: string,
  currency: string,
  received: KinMoney | null,
): Checked<KinMoney | null> {
  if (text.trim() === "")
    return received === null
      ? { ok: true, value: null }
      : { ok: false, problem: "This entry has payments, so it needs an amount." };
  const amount = kinParseMoney(text, currency);
  if (amount === null) return { ok: false, problem: AMOUNT_PROBLEM };
  if (received === null) return { ok: true, value: amount };
  if (amount.currency !== received.currency)
    return {
      ok: false,
      problem: `Its payments are in ${received.currency}. Take them back before changing the currency.`,
    };
  if (amount.minor < received.minor)
    return {
      ok: false,
      problem: `${kinMoneyText(received, true)} has already been received, so the amount can't be less. Take a payment back first.`,
    };
  return { ok: true, value: amount };
}

const FIELD_TEXT_MAX = 500;
export const KIN_FIELD_FILES_MAX = 10;

/**
 * One edited field as the host stores it (null clears it), or why it can't be saved. Text and
 * amounts come as typed; a choice, a day, a person (`kinPrincipalValue`), a client's or project's
 * record id and file ids come from their pickers.
 */
export function kinFieldCheck(
  field: Pick<KinListFieldView, "type" | "label">,
  draft: string | ReadonlyArray<string> | null,
  currency: string,
): Checked<KinFieldValue | null> {
  if (draft === null) return { ok: true, value: null };
  if (typeof draft !== "string") {
    if (draft.length > KIN_FIELD_FILES_MAX)
      return { ok: false, problem: `${field.label} keeps at most ${KIN_FIELD_FILES_MAX} files.` };
    return { ok: true, value: draft.length === 0 ? null : [...draft] };
  }
  const text = draft.trim();
  if (text === "") return { ok: true, value: null };
  if (field.type === "money") {
    const amount = kinParseMoney(text, currency);
    return amount === null ? { ok: false, problem: AMOUNT_PROBLEM } : { ok: true, value: amount };
  }
  if (field.type === "date" && !DAY.test(text)) return { ok: false, problem: "Pick a day." };
  if (text.length > FIELD_TEXT_MAX)
    return { ok: false, problem: `${field.label} can be ${FIELD_TEXT_MAX} characters at most.` };
  return { ok: true, value: text };
}

export interface KinPaymentDraft {
  readonly amount: string;
  /** `YYYY-MM-DD`. */
  readonly paidOn: string;
  readonly note: string;
}

/** What was typed as a payment, or why it can't be recorded. */
export function kinPaymentCheck(
  draft: KinPaymentDraft,
  left: KinMoney,
):
  | { readonly ok: true; readonly amount: KinMoney }
  | { readonly ok: false; readonly problem: string } {
  const amount = kinParseAmount(draft.amount, left.currency);
  if (amount === null)
    return { ok: false, problem: "Enter the amount received, like 40,000 or 40000.50." };
  if (amount.minor > left.minor)
    return {
      ok: false,
      problem: `That's more than the ${kinMoneyText(left, true)} still owed.`,
    };
  if (!DAY.test(draft.paidOn)) return { ok: false, problem: "Pick the day it was received." };
  return { ok: true, amount };
}

export type KinListOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly problem: string;
      /** It moved on since it was read: the latest is on screen now. */
      readonly changed: boolean;
    };

const KIN_LIST_OFFLINE = "You're offline. Try again when you're back.";

/** One change to an entry or a list, answered with the new value or a reason in words. */
export async function kinListSend<A>(input: {
  readonly online: () => boolean;
  readonly send: () => Promise<AtomCommandResult<A, unknown>>;
}): Promise<KinListOutcome<A>> {
  if (!input.online()) return { ok: false, problem: KIN_LIST_OFFLINE, changed: false };
  const result = await input.send();
  if (AsyncResult.isSuccess(result)) return { ok: true, value: result.value };
  const error = squashAtomCommandFailure(result);
  const failed = (problem: string, changed = false) => ({ ok: false as const, problem, changed });
  if (isKinWorkAuthorizationError(error))
    return failed("This device isn't allowed to change this.");
  if (!isKinChatError(error))
    return failed("That didn't go through. Check your connection and try again.");
  switch (error.reason) {
    case "conflict":
      return failed("This changed while you were looking at it. Check it and try again.", true);
    case "not_found":
      return failed("That isn't there any more.");
    case "not_allowed":
      return failed("Only whoever runs this Kin can change this.");
    case "unavailable":
    case "disabled":
      return failed("Kin isn't answering right now. Try again in a moment.");
    case "invalid_state":
      // The host says exactly what it refused; words meant for an agent's tools are not shown.
      return failed(
        /[a-z]+_[a-z]+/.test(error.message)
          ? "That didn't go through. Check the details and try again."
          : error.message,
      );
    default:
      return failed("That didn't go through. Check the details and try again.");
  }
}

export interface KinListEditDraft {
  readonly name: string;
  readonly stateLabels: Readonly<Partial<Record<KinRecordState, string>>>;
  /** By category as stored. */
  readonly categoryLabels: Readonly<Record<string, string>>;
  readonly payments: boolean;
}

export const kinListEditDraftOf = (def: KinListDefinition): KinListEditDraft => ({
  name: def.name,
  stateLabels: Object.fromEntries(
    def.states.map((state) => [state, kinListStateLabel(def, state)]),
  ),
  categoryLabels: Object.fromEntries(
    def.categories.map((category) => [category, kinCategoryLabel(category, def)]),
  ),
  payments: def.payments === true,
});

/** Whether the list's settings offer "paid in parts": a list with amounts that isn't Invoices. */
export const kinListCanTogglePayments = (def: KinListDefinition) =>
  def.amount && !def.builtIn && def.list !== "invoices";

const LABEL_MAX = 60;
export const KIN_LIST_LABEL_MAX = LABEL_MAX;

/** The rename as the host takes it, null with nothing changed, or why it can't be saved. */
export function kinListEditInput(
  orgId: KinOrgId,
  def: KinListDefinition,
  draft: KinListEditDraft,
):
  | { readonly ok: true; readonly input: KinListUpdateInput | null }
  | { readonly ok: false; readonly problem: string } {
  const name = draft.name.trim();
  if (name === "") return { ok: false, problem: "Give the list a name." };
  const labels: Partial<Record<KinRecordState, string>> = {};
  for (const state of def.states) {
    const label = (draft.stateLabels[state] ?? "").trim();
    if (label === "") return { ok: false, problem: "Every status needs a name." };
    if (label !== kinListStateLabel(def, state)) labels[state] = label;
  }
  const categories: Record<string, string | null> = {};
  for (const category of def.categories) {
    const label = (draft.categoryLabels[category] ?? "").trim();
    if (label === kinCategoryLabel(category, def)) continue;
    // Cleared, or typed back as stored: it shows as stored again.
    categories[category] = label === "" || label === category ? null : label;
  }
  const renamed = name !== def.name;
  const payments = draft.payments !== (def.payments === true);
  if (
    !renamed &&
    !payments &&
    Object.keys(labels).length === 0 &&
    Object.keys(categories).length === 0
  )
    return { ok: true, input: null };
  return {
    ok: true,
    input: {
      orgId,
      list: def.list,
      rev: def.rev,
      ...(renamed ? { name: name as KinListDefinition["name"] } : {}),
      ...(Object.keys(labels).length === 0
        ? {}
        : { stateLabels: labels as KinListUpdateInput["stateLabels"] }),
      ...(Object.keys(categories).length === 0
        ? {}
        : { categoryLabels: categories as KinListUpdateInput["categoryLabels"] }),
      ...(payments ? { payments: draft.payments } : {}),
    },
  };
}

const SHOWS: ReadonlyArray<string> = ["all", "open", "doing", "waiting", "done", "dropped"];
const GROUPS: ReadonlyArray<string> = ["none", "category", "month", "financialYear"];
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** A filter carried in a link, such as the one a Money figure opens. Anything odd is left out. */
export function kinListFilterParam(text: string | undefined): KinListFilter {
  if (text === undefined) return KIN_LIST_DEFAULT_FILTER;
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch {
    return KIN_LIST_DEFAULT_FILTER;
  }
  if (typeof held !== "object" || held === null) return KIN_LIST_DEFAULT_FILTER;
  const from = held as Record<string, unknown>;
  const period = (value: unknown): KinPeriod | null => {
    if (typeof value !== "object" || value === null) return null;
    const { from: first, to: last } = value as Record<string, unknown>;
    return typeof first === "string" &&
      typeof last === "string" &&
      DAY_TEXT.test(first) &&
      DAY_TEXT.test(last)
      ? { from: first, to: last }
      : null;
  };
  const ref = (value: unknown): KinWorkRef | null => {
    if (typeof value !== "object" || value === null) return null;
    const { key, title } = value as Record<string, unknown>;
    return typeof key === "string" && typeof title === "string"
      ? { key: key as KinRecordKey, title }
      : null;
  };
  return {
    ...KIN_LIST_DEFAULT_FILTER,
    ...(typeof from.show === "string" && SHOWS.includes(from.show)
      ? { show: from.show as KinListShow }
      : {}),
    late: from.late === true,
    category: typeof from.category === "string" && from.noCategory !== true ? from.category : null,
    noCategory: from.noCategory === true,
    noParty: from.noParty === true,
    period: period(from.period),
    paid: period(from.paid),
    party: from.noParty === true ? null : ref(from.party),
    project: ref(from.project),
    ...(typeof from.groupBy === "string" && GROUPS.includes(from.groupBy)
      ? { groupBy: from.groupBy as KinListGroupBy }
      : {}),
  };
}
