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
  KinBankKnown,
  KinMoneyTotals,
  KinOrgId,
  KinPayment,
  KinPaymentSource,
  KinRecord,
  KinRecordDetail,
  KinRecordKey,
  KinRecordState,
  KinWorkListInput,
  KinWorkPrincipal,
} from "@t3tools/contracts";
import {
  formatKinMoney,
  KIN_DEFAULT_HOME_CURRENCY,
  kinCurrency,
  parseKinMoney,
  kinWhenFormat,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { KIN_OFFLINE_NOT_SENT, kinFailure } from "./kinAnswers.ts";
import {
  isKinChatError,
  kinWorkAllDay,
  kinWorkClosed,
  kinWorkDueLabel,
  kinWorkDueText,
  kinWorkName,
  kinRepeatText,
  type KinWorkNames,
  type KinWorkRef,
} from "./kinWork.ts";

/**
 * Lists an agent set up in chat, as data: any fields, states and categories, with or without
 * amounts, dates, files and repeats. Nothing here knows what a list is for.
 */

/** How far Kin sees the bank, and where a payment came from, as people read it. */
export const KIN_BANK = {
  knownTo: (day: string) => `Bank known to ${day}`,
  unseen: "Kin can't see the bank yet: upload a statement",
  upload: "Upload a statement",
  /** The chat it opens starts with this; the statement is attached there, as always. */
  uploadMessage: "Here is the bank statement: ",
  notPaid: (day: string | null) =>
    day === null
      ? "Not recorded as paid. Kin can't see the bank yet."
      : `Not recorded as paid. Bank known to ${day}.`,
  restNotPaid: (day: string | null) =>
    day === null
      ? "The rest isn't recorded as paid. Kin can't see the bank yet."
      : `The rest isn't recorded as paid. Bank known to ${day}.`,
  fromStatement: "from the bank statement",
  recordedBy: (name: string) => `recorded by ${name}`,
  recordedOnWord: (agent: string, person: string) => `recorded by ${agent} on ${person}'s word`,
  recordedHere: "recorded in Kin",
};

const bankDayFormat = kinWhenFormat("date", { zone: "UTC" });
const bankDayYearFormat = kinWhenFormat("dateYear", { zone: "UTC" });
/** "31 Oct", with its year when it isn't this one. */
const kinBankDay = (day: string, now: Date) => {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return day.slice(0, 4) === String(now.getFullYear())
    ? bankDayFormat.format(at)
    : bankDayYearFormat.format(at);
};

/** Money's quiet line: how far Kin sees the bank; null from a host that doesn't say. */
export const kinBankKnownText = (known: KinBankKnown | undefined, now: Date) =>
  known === undefined
    ? null
    : known.through === null
      ? KIN_BANK.unseen
      : KIN_BANK.knownTo(kinBankDay(known.through, now));

/**
 * An Invoices draft nothing came in on shows no balance: it is owed once issued. Display only;
 * `balance` stays on the record, as Mark paid and older phones record a payment from it.
 */
export const kinDraftShowsNoBalance = (
  item: Pick<KinRecord, "list" | "state" | "amount" | "balance">,
) =>
  item.list === "invoices" &&
  item.state === "open" &&
  item.balance !== undefined &&
  item.amount !== undefined &&
  item.balance.minor >= item.amount.minor;

/** An issued invoice's line while some of it is owed: never more certain than the bank. */
export const kinInvoiceBankText = (
  item: Pick<KinRecordDetail, "state" | "bankKnown" | "balance" | "amount">,
  now: Date,
) => {
  const known = item.bankKnown;
  if (known === undefined || item.state !== "waiting" || item.balance === undefined) return null;
  if (item.balance.minor === 0) return null;
  const day = known.through === null ? null : kinBankDay(known.through, now);
  return item.amount !== undefined && item.balance.minor < item.amount.minor
    ? KIN_BANK.restNotPaid(day)
    : KIN_BANK.notPaid(day);
};

/** Where a payment came from; null from a host that doesn't say. */
export const kinPaymentSourceText = (
  source: KinPaymentSource | undefined,
  names: Pick<KinWorkNames, "people" | "agents">,
) => {
  if (source === undefined) return null;
  switch (source._tag) {
    case "statement":
      return KIN_BANK.fromStatement;
    case "person": {
      const person = names.people.get(source.personId) ?? "someone";
      return source.agentId === undefined
        ? KIN_BANK.recordedBy(person)
        : KIN_BANK.recordedOnWord(names.agents.get(source.agentId) ?? "an agent", person);
    }
    case "agent":
      return KIN_BANK.recordedBy(names.agents.get(source.agentId) ?? "an agent");
    case "recorded":
      return KIN_BANK.recordedHere;
  }
};

export const KIN_LISTS = {
  listGone: "This list isn't here",
  goneDetail: "It may have been renamed. Open Docs to see the lists there are.",
  title: "Lists",
  search: "Search this list",
  /** A list opened from a Money figure: only what the figure counted. */
  kept: "Counted in Money",
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
  expired: "Expired",
  noCategory: "No category",
  noClient: "No client",
  anyCategory: "Any category",
  anyClient: "Any client",
  clientFilter: "Client",
  billed: "Billed",
  sentWaiting: "Sent, waiting",
  accepted: "Accepted",
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
  view: "View",
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
    payNotePlaceholder: "How it was paid, or its reference",
    payTds: "TDS deducted",
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
    amountPlaceholder: "Amount, and its currency if it isn't yours",
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
    archiveDetail:
      "It stops taking new entries. Nothing is deleted, and you can bring it back here in its settings.",
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

/** How many digits follow the point in `currency`: 2 for rupees, 0 for yen. */
export const kinMinorDigits = (currency: string) => kinCurrency(currency).decimals;

/**
 * What a person calls an entry: its issued number (INV/26-27/004), else its key while it has none.
 * `number` is a ref's own, or an entry's `fields.number`.
 */
export const kinRecordName = (key: string, number: unknown) =>
  typeof number === "string" && number.trim() !== "" ? number.trim() : key;

/** An exact amount: "₹4,20,000", with paise only when there are some unless `paise` keeps them. */
export const kinMoneyText = (money: KinMoney, paise = false) =>
  formatKinMoney(money.minor, money.currency, { cents: paise ? "always" : "some", minus: "−" });

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

/**
 * An amount with the currency it names ("$120.50", "EUR 40", "₹4,200", "4.2 lakh"), else in
 * `fallback`. Null when it isn't an amount, is zero, or names two currencies.
 */
export function kinParseMoney(text: string, fallback: string): KinMoney | null {
  const read = parseKinMoney(text, fallback);
  return "money" in read && read.money.minor > 0 ? read.money : null;
}

/** An amount typed in `currency`, in minor units; null when it isn't one, is zero or names another. */
const kinParseAmount = (text: string, currency: string): KinMoney | null => {
  const money = kinParseMoney(text, currency);
  return money === null || money.currency !== currency ? null : money;
};

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

/** "FY 2026–27" for `FY2026-27`, "FY 2026" for `FY2026`. */
export const kinFinancialYearLabel = (year: string) =>
  year.length > 6 ? `FY ${year.slice(2, 6)}–${year.slice(7)}` : `FY ${year.slice(2, 6)}`;
/** "April to March": the months a financial year starting in `startMonth` runs. */
export const kinFinancialYearMonths = (startMonth: number) =>
  `${MONTHS[startMonth - 1]} to ${MONTHS[(startMonth + 10) % 12]}`;

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

/**
 * A financial year's days. `FY2026` is the calendar year; one across two years starts in
 * `startMonth`, April where the host didn't say, as hosts before company years were set.
 */
export function kinFinancialYearPeriod(year: string, startMonth?: number): KinPeriod {
  const start = Number(year.slice(2, 6));
  const first = year.length > 6 ? (startMonth ?? 4) : 1;
  if (first === 1) return { from: `${start}-01-01`, to: `${start}-12-31` };
  const end = kinMonthPeriod(`${start + 1}-${pad(first - 1)}`);
  return { from: `${start}-${pad(first)}-01`, to: end.to };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayMonthFormat = kinWhenFormat("date");
const dayMonthYearFormat = kinWhenFormat("dateYear");
const localDay = (day: string) => {
  const found = DAY.exec(day);
  return found === null ? null : new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3]));
};

/** A period in words: a whole month or financial year by name, anything else by its days. */
export function kinPeriodLabel(period: KinPeriod): string {
  const month = period.from.slice(0, 7);
  const whole = kinMonthPeriod(month);
  if (whole.from === period.from && whole.to === period.to) return kinMonthLabel(month);
  const start = Number(period.from.slice(0, 4));
  const first = Number(period.from.slice(5, 7));
  const year = `FY${start}-${String(start + 1).slice(2)}`;
  if (first > 1 && period.from.endsWith("-01")) {
    const fy = kinFinancialYearPeriod(year, first);
    if (fy.from === period.from && fy.to === period.to) return kinFinancialYearLabel(year);
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

export const KIN_SUGGESTED = "Suggested";
/**
 * An entry nobody with the right has kept or dropped, whatever its state or amount: it waits on
 * Keep. The host counts it in no figure.
 */
export const kinSuggestion = (record: Pick<KinRecord, "confirmed" | "state">) =>
  !record.confirmed && record.state !== "dropped";
/** Lists whose every entry is money: a suggestion there is owed, due or overdue nowhere. */
const KIN_MONEY_LISTS: ReadonlySet<string> = new Set([
  "quotes",
  "invoices",
  "expenses",
  "receipts",
  "subscriptions",
]);
export const KIN_SUGGESTION_NOTE = "Not in any Money figure until you keep it.";
/** A draft invoice kept is still a draft: owed nowhere until it is issued. */
const KIN_SUGGESTED_DRAFT_NOTE =
  "Not in any Money figure until you keep it, and not owed until it's issued.";
/**
 * On a suggestion's own page: the note when Money would count it once kept, and whether Not
 * needed works there, which drops it: a list with no Dropped state offers only Keep.
 */
export const kinSuggestionKeep = (
  record: Pick<KinRecord, "list" | "amount"> & Partial<Pick<KinRecord, "state">>,
  def: Pick<KinListDefinition, "states"> | null,
) => ({
  note:
    record.list === "invoices" && record.state === "open"
      ? KIN_SUGGESTED_DRAFT_NOTE
      : KIN_MONEY_LISTS.has(record.list ?? "work") || record.amount !== undefined
        ? KIN_SUGGESTION_NOTE
        : null,
  declines: def === null ? (record.list ?? "work") === "work" : def.states.includes("dropped"),
});
/** Lists whose Waiting is issued or sent, which nobody made a suggestion. */
const KIN_ISSUED_LISTS: ReadonlySet<string> = new Set(["quotes", "invoices"]);
/**
 * A state's words for a person, a suggestion's first saying so: "Suggested · Paid", and only
 * "Suggested" where its state would read issued or sent.
 */
export const kinSuggestionText = (
  record: Pick<KinRecord, "confirmed" | "state" | "list">,
  label: string,
) =>
  !kinSuggestion(record)
    ? label
    : record.state === "waiting" && KIN_ISSUED_LISTS.has(record.list ?? "work")
      ? KIN_SUGGESTED
      : `${KIN_SUGGESTED} · ${label}`;
const KIN_DAY = "Date";
/** The day's label, or the plain one on a suggestion or draft where it names a state, as Issued does. */
const kinDayLabel = (
  def: Pick<KinListDefinition, "dateLabel" | "states" | "stateLabels">,
  notIssued: boolean,
) =>
  notIssued && def.states.some((state) => kinListStateLabel(def, state) === def.dateLabel)
    ? KIN_DAY
    : def.dateLabel;
/** Not gone out yet: a suggestion or a draft, whose day is no issue day. */
const kinNotIssued = (item: Pick<KinRecord, "confirmed" | "state">) =>
  kinSuggestion(item) || item.state === "open";
/** Late as a figure would read it: never for a suggestion in a money list. */
const kinLateShown = (record: Pick<KinRecord, "late" | "confirmed" | "list">) =>
  record.late && (record.confirmed || !KIN_MONEY_LISTS.has(record.list ?? "work"));
const kinSuggestionStateLabel = (
  def: Pick<KinListDefinition, "stateLabels"> | null,
  record: Pick<KinRecord, "confirmed" | "state" | "list">,
) => kinSuggestionText(record, kinListStateLabel(def, record.state));

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

/** `notClosed`: every entry not yet closed; a state alone, `open` included, is just that state. */
export type KinListShow = "all" | "notClosed" | KinRecordState;

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
  /** `true`: only what Money's figures count, as a figure opens it; `false`: only suggestions. */
  readonly kept: boolean | null;
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
  kept: null,
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
  a.kept === b.kept &&
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
      : filter.show === "notClosed"
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
    ...(filter.kept === null ? {} : { kept: filter.kept }),
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
      selected: plain && (filter.show === "all" || filter.show === "notClosed"),
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
    ...(filter.kept === null
      ? []
      : [
          {
            id: "kept",
            label: filter.kept ? KIN_LISTS.kept : KIN_SUGGESTED,
            cleared: { ...filter, kept: null },
          },
        ]),
  ];
}

/** Everything a list is narrowed to, as the one chip its Filter shows; null on the whole list. */
export function kinListFilterLabel(def: KinListDefinition, filter: KinListFilter): string | null {
  const state = kinListChips(def, filter).find((chip) => chip.selected && chip.id !== "all");
  const parts = [
    ...(state === undefined ? [] : [state.label]),
    ...kinListNarrowings(filter, def).map((narrowing) => narrowing.label),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The whole list again, keeping what is typed in search and how the totals split. */
export const kinListFilterCleared = (filter: KinListFilter): KinListFilter => ({
  ...KIN_LIST_DEFAULT_FILTER,
  text: filter.text,
  groupBy: filter.groupBy,
});

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
  readonly id: "total" | "owed" | "received" | "sent" | "accepted";
  /** Null for the only figure of a list that isn't paid over time: it needs no name. */
  readonly label: string | null;
  readonly lines: ReadonlyArray<string>;
}

type Sums = Pick<KinListTotals, "total" | "owed" | "received" | "sent" | "accepted">;

/**
 * The figures a filter's sums make, the one the filter is about first: what was received in a
 * paid window, else what is still owed where entries are paid over time, then what was billed.
 */
function figuresOf(def: KinListDefinition, sums: Sums): ReadonlyArray<KinListFigure> {
  if (!def.amount) return [];
  const some = (totals: KinMoneyTotals) =>
    totals.length === 0 ? [KIN_MONEY_NOTHING] : kinTotalsLines(totals);
  const billed = { id: "total" as const, label: KIN_LISTS.billed, lines: some(sums.total) };
  // Quotes add up only what is out and what was won; a draft is not money yet.
  if (sums.sent !== undefined || sums.accepted !== undefined)
    return [
      { id: "sent", label: KIN_LISTS.sentWaiting, lines: some(sums.sent ?? []) },
      { id: "accepted", label: KIN_LISTS.accepted, lines: some(sums.accepted ?? []) },
    ];
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
  /** The full amounts, one line per currency; empty without amounts, and for quotes. */
  readonly totals: ReadonlyArray<string>;
  /** One line under a few entries shown elsewhere: "₹40,000 in all", or a quotes' two sums. */
  readonly summary: string | null;
  readonly count: string | null;
  readonly groups: ReadonlyArray<KinListGroupView>;
}

/** The figures over a list: exact sums of every match, and the same split by group. */
export function kinListHeader(
  def: KinListDefinition,
  filter: KinListFilter,
  totals: KinListTotals | null,
  total: number | null,
  /** The month the company's year starts in, which a financial-year group runs from. */
  yearStartMonth?: number,
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
          : kinFinancialYearPeriod(group.group, yearStartMonth);
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
  const figures = totals === null ? [] : figuresOf(def, totals);
  const quotes = figures[0]?.id === "sent";
  const full = def.amount && totals !== null && !quotes ? kinTotalsLines(totals.total) : [];
  return {
    figures,
    totals: full,
    summary: quotes
      ? figures.map((figure) => `${figure.label}: ${figure.lines.join(" and ")}`).join(" · ")
      : full.length === 0 || (total ?? 0) < 2
        ? null
        : `${full.join(" and ")} in all`,
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
  /** The month the company's year starts in; absent from an older host, whose years start in April. */
  readonly yearStartMonth?: number;
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

const dayText = (day: string, now: Date, zone: string | null) =>
  DAY.test(day) ? kinWorkDueLabel(day, now, zone) : day;

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
      return dayText(value, context.now, context.names.zone);
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
    ...(def.dateLabel === undefined
      ? []
      : [text("date", kinDayLabel(def, records.some(kinNotIssued)) ?? def.dateLabel)]),
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
    ...(records.some((record) => record.balance !== undefined && !kinDraftShowsNoBalance(record))
      ? [{ id: "owed", label: KIN_LISTS.entry.left, numeric: true }]
      : []),
  ];
}

/** A day phrase, "Due Sun, Nov 8", that wraps as one piece on a narrow row. */
const keepTogether = (text: string) => text.replaceAll(" ", "\u00a0");

export function kinListRow(
  record: KinRecord,
  def: KinListDefinition | null,
  context: KinListContext,
  /** What the list around the row already says. */
  within?: { readonly party?: KinRecordKey | null; readonly list?: boolean },
): KinListRowView {
  const { names, now } = context;
  const closed = kinWorkClosed(record.state);
  const stateLabel = kinSuggestionStateLabel(def, record);
  const late = kinLateShown(record);
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
    kinRecordName(record.key, record.fields?.number),
    within?.list === false && def !== null ? def.name : null,
    record.listCategory === undefined ? null : kinCategoryLabel(record.listCategory, def),
    stateLabel,
    date,
    dueLine,
    party,
    record.repeat === undefined ? null : kinRepeatText(record.repeat).toLowerCase(),
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
    ...(record.balance === undefined || kinDraftShowsNoBalance(record)
      ? {}
      : { owed: kinMoneyText(record.balance, true) }),
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
    late,
    suggested: kinSuggestion(record),
    amount,
    owed,
    line: parts
      .map((part) => (part === date || part === dueLine ? keepTogether(part) : part))
      .join(" · "),
    accessibilityLabel: [
      record.title,
      amount,
      owed,
      ...parts.slice(1),
      late ? (def?.list === "quotes" ? KIN_LISTS.expired : KIN_LISTS.late) : null,
    ]
      .filter((part) => part !== null)
      .join(". "),
    cells,
  };
}

// One entry

/** What only a kept entry in a money list may move to: issued or sent, and paid or accepted. */
const MONEY_MOVES: ReadonlySet<KinRecordState> = new Set(["waiting", "done"]);

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
  /** "from the bank statement", "recorded by Rhea"; null from an older host. */
  readonly source: string | null;
}

export interface KinListEntryView {
  /** "EXP-31 · Expenses". */
  readonly heading: string;
  readonly state: KinRecordState;
  readonly stateLabel: string;
  /** Nobody kept or dropped it yet: it offers Keep and Not needed, whatever its state. */
  readonly suggested: boolean;
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
  /** An invoice's payment form also takes the TDS the client deducted. */
  readonly takesTds: boolean;
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
  const suggested = kinSuggestion(item);
  // A suggestion is paid, issued or sent by nobody until it is kept (the host refuses each).
  const canFinish = !closed && !suggested && (def === null || def.states.includes("done"));
  const moves = suggested && KIN_MONEY_LISTS.has(item.list ?? "work") ? MONEY_MOVES : null;
  return {
    heading:
      def === null
        ? kinRecordName(item.key, item.fields?.number)
        : `${kinRecordName(item.key, item.fields?.number)} · ${def.name}`,
    state: item.state,
    stateLabel: kinSuggestionStateLabel(def, item),
    suggested,
    closed,
    late: kinLateShown(item),
    amount: item.amount === undefined ? null : kinMoneyText(item.amount, true),
    amountEdit:
      def?.amount === true || item.amount !== undefined
        ? {
            draft:
              item.amount === undefined
                ? ""
                : kinMoneyDraft(item.amount, def?.currency ?? item.amount.currency),
            currency: item.amount?.currency ?? def?.currency ?? KIN_DEFAULT_HOME_CURRENCY,
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
    takesTds: item.list === "invoices",
    payments: (item.payments ?? []).map((payment: KinPayment) => ({
      paymentId: payment.paymentId,
      amount: kinMoneyText(payment.amount, true),
      when: dayText(payment.paidOn, now, names.zone),
      note:
        [payment.withheld === true ? KIN_LISTS.entry.payTds : null, payment.note.trim()]
          .filter((part) => part !== null && part !== "")
          .join(" · ") || null,
      voided: payment.voidedAt !== null,
      source: kinPaymentSourceText(payment.source, names),
    })),
    states: (def?.states ?? [item.state])
      .filter((state) => state === item.state || moves === null || !moves.has(state))
      .map((state) => ({
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
    dateLabel:
      def === null
        ? item.dateAt === undefined
          ? null
          : KIN_DAY
        : (kinDayLabel(def, kinNotIssued(item)) ?? null),
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
  const number = formatKinMoney(money.minor, money.currency, { bare: true });
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
  /** TDS the client deducted, on an invoice; blank for none. */
  readonly tds?: string;
}

/** What was typed as a payment, or why it can't be recorded. */
export function kinPaymentCheck(
  draft: KinPaymentDraft,
  left: KinMoney,
):
  | { readonly ok: true; readonly amount: KinMoney; readonly tds?: KinMoney }
  | { readonly ok: false; readonly problem: string } {
  const tdsText = draft.tds?.trim() ?? "";
  const tds = tdsText === "" ? null : kinParseAmount(tdsText, left.currency);
  if (tdsText !== "" && (tds === null || tds.minor === 0))
    return { ok: false, problem: "Enter the TDS deducted, like 4,000, or leave it blank." };
  // With TDS, the cash received may be left blank: the client kept it all as tax.
  const amount =
    tds !== null && draft.amount.trim() === ""
      ? { minor: 0, currency: left.currency }
      : kinParseAmount(draft.amount, left.currency);
  if (amount === null || (amount.minor === 0 && tds === null))
    return { ok: false, problem: "Enter the amount received, like 40,000 or 40000.50." };
  if (amount.minor + (tds?.minor ?? 0) > left.minor)
    return {
      ok: false,
      problem: `That's more than the ${kinMoneyText(left, true)} still owed.`,
    };
  if (!DAY.test(draft.paidOn)) return { ok: false, problem: "Pick the day it was received." };
  return tds === null ? { ok: true, amount } : { ok: true, amount, tds };
}

export type KinListOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly problem: string;
      /** It moved on since it was read: the latest is on screen now. */
      readonly changed: boolean;
      /** The amount reads like a slip: the one line the form asks, `problem` too. */
      readonly slip?: string;
    };

export const KIN_AMOUNT_SLIP = {
  far: (list: string, largest: string) =>
    `That is far above anything in ${list} so far (the largest is ${largest}). Save it anyway?`,
  empty: (list: string) => `That is far above what ${list} holds so far. Save it anyway?`,
  save: "Save anyway",
};

/** The line a form asks when the host found its amount far above its list; null for other errors. */
export function kinAmountSlipLine(error: unknown): string | null {
  if (!isKinChatError(error) || error.farAbove === undefined) return null;
  const { list, largest } = error.farAbove;
  return largest === null
    ? KIN_AMOUNT_SLIP.empty(list)
    : KIN_AMOUNT_SLIP.far(list, kinMoneyText(largest));
}

/** A form's question about one amount, `about` being that amount as the form holds it. */
export interface KinAmountAsk {
  readonly line: string;
  readonly about: string;
}

/** The question while the amount is still the one asked about; changing it clears the question. */
export const kinAmountAsking = (ask: KinAmountAsk | null, about: string) =>
  ask !== null && ask.about === about ? ask : null;

/**
 * What a form that asks sends with its amount: false asks the host to check it, true, once the
 * person was asked about this very amount and saves again, keeps it.
 */
export const kinAmountConfirmed = (ask: KinAmountAsk | null, about: string) => ({
  amountConfirmed: kinAmountAsking(ask, about) !== null,
});

/** One change to an entry or a list, answered with the new value or a reason in words. */
export async function kinListSend<A>(input: {
  readonly online: () => boolean;
  readonly send: () => Promise<AtomCommandResult<A, unknown>>;
}): Promise<KinListOutcome<A>> {
  if (!input.online()) return { ok: false, problem: KIN_OFFLINE_NOT_SENT, changed: false };
  const result = await input.send();
  if (AsyncResult.isSuccess(result)) return { ok: true, value: result.value };
  const error = squashAtomCommandFailure(result);
  const slip = kinAmountSlipLine(error);
  if (slip !== null) return { ok: false, problem: slip, changed: false, slip };
  // A retry key reused for something else: the form's id is stale, not the person's rights.
  if (isKinChatError(error) && error.reason === "not_allowed" && /retry key/i.test(error.message))
    return {
      ok: false,
      problem: "This was already sent once with different details. Close it and start again.",
      changed: false,
    };
  const failure = kinFailure(error, "That didn't go through.", {
    device: "This device isn't allowed to change this.",
  });
  return { ok: false, problem: failure.text, changed: failure.kind === "changed" };
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

const SHOWS: ReadonlyArray<string> = [
  "all",
  "notClosed",
  "open",
  "doing",
  "waiting",
  "done",
  "dropped",
];
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
