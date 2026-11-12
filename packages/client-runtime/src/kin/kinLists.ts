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

/** Categories are stored as typed, usually lower case; shown with a capital. */
export const kinCategoryLabel = (category: string) =>
  category.charAt(0).toUpperCase() + category.slice(1);

/** "Today" reads as "today" after a label; a date keeps its capitals. */
const afterLabel = (when: string) =>
  /^(Today|Tomorrow|Yesterday)/.test(when) ? when.charAt(0).toLowerCase() + when.slice(1) : when;

/** Totals in a sentence: "₹4,20,000 and $13", or "Nothing". */
export const kinTotalsText = (totals: KinMoneyTotals, nothing = KIN_MONEY_NOTHING) =>
  totals.length === 0 ? nothing : kinTotalsLines(totals).join(" and ");

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
    ...(filter.category === null ? {} : { listCategory: filter.category }),
    ...(filter.period === null ? {} : { dateFrom: filter.period.from, dateTo: filter.period.to }),
    ...(filter.paid === null ? {} : { paidFrom: filter.paid.from, paidTo: filter.paid.to }),
    ...(filter.party === null ? {} : { party: filter.party.key }),
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
export function kinListNarrowings(filter: KinListFilter): ReadonlyArray<KinListNarrowing> {
  return [
    ...(filter.category === null
      ? []
      : [
          {
            id: "category",
            label: kinCategoryLabel(filter.category),
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
    ...(filter.party === null
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

export interface KinListGroupView {
  readonly key: string;
  readonly label: string;
  /** "14 entries". */
  readonly count: string;
  /** One line per currency; empty in a list without amounts. */
  readonly totals: ReadonlyArray<string>;
  /** The list narrowed to this group; null for a group that can't be asked for on its own. */
  readonly narrowed: KinListFilter | null;
  readonly selected: boolean;
}

const countText = (count: number) => (count === 1 ? "1 entry" : `${count} entries`);

export interface KinListHeaderView {
  /** One line per currency for everything the filter matches; empty without amounts. */
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
    const base = {
      count: countText(group.count),
      totals: def.amount ? kinTotalsLines(group.total) : [],
    };
    if (filter.groupBy === "category") {
      const selected = group.group !== null && filter.category === group.group;
      return {
        ...base,
        key: group.group ?? "",
        label: group.group === null ? KIN_LISTS.noCategory : kinCategoryLabel(group.group),
        narrowed:
          group.group === null ? null : { ...filter, category: selected ? null : group.group },
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
    record.listCategory === undefined ? null : kinCategoryLabel(record.listCategory),
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
      : { category: kinCategoryLabel(record.listCategory) }),
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
  readonly id: "category" | "date" | "due" | "party" | "project" | "owner" | "repeat";
  readonly label: string;
  readonly value: string;
  /** The client or project it opens. */
  readonly opens: KinRecordKey | null;
}

export interface KinListFieldView {
  readonly key: string;
  readonly label: string;
  readonly type: KinListField["type"];
  /** Null when the entry has nothing in it. */
  readonly text: string | null;
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
  /** Entries that take payments: what is still owed and what came in. */
  readonly balance: {
    readonly left: KinMoney;
    readonly leftText: string;
    readonly receivedText: string;
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
  const facts: Array<KinListFactView> = [];
  if (item.listCategory !== undefined)
    facts.push({
      id: "category",
      label: KIN_LISTS.entry.category,
      value: kinCategoryLabel(item.listCategory),
      opens: null,
    });
  if (item.party !== undefined)
    facts.push({
      id: "party",
      label: KIN_LISTS.entry.client,
      value: item.party.title,
      opens: item.party.key,
    });
  if (item.project !== undefined)
    facts.push({
      id: "project",
      label: KIN_LISTS.entry.project,
      value: item.project.title,
      opens: item.project.key,
    });
  facts.push({
    id: "owner",
    label: KIN_LISTS.entry.owner,
    value: kinWorkName(item.owner, names),
    opens: null,
  });
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
    balance:
      item.balance === undefined || received === null
        ? null
        : {
            left: item.balance,
            leftText: kinMoneyText(item.balance, true),
            receivedText: kinMoneyText(received, true),
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
    default:
      return failed("That didn't go through. Check the details and try again.");
  }
}

export interface KinListEditDraft {
  readonly name: string;
  readonly stateLabels: Readonly<Partial<Record<KinRecordState, string>>>;
}

export const kinListEditDraftOf = (def: KinListDefinition): KinListEditDraft => ({
  name: def.name,
  stateLabels: Object.fromEntries(
    def.states.map((state) => [state, kinListStateLabel(def, state)]),
  ),
});

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
  const renamed = name !== def.name;
  if (!renamed && Object.keys(labels).length === 0) return { ok: true, input: null };
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
    },
  };
}
