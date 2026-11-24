import type {
  KinCash,
  KinChartSpec,
  KinListDefinition,
  KinListId,
  KinMoneySummary,
  KinMoneyTotals,
  KinRecordKey,
} from "@t3tools/contracts";

import { kinBilledName } from "./kinBillTo.ts";
import {
  KIN_LIST_DEFAULT_FILTER,
  KIN_MONEY_NOTHING,
  KIN_SUGGESTED,
  KIN_SUGGESTION_NOTE,
  kinCategoryLabel,
  kinFinancialYearLabel,
  kinFinancialYearMonths,
  kinFinancialYearPeriod,
  kinMonthLabel,
  kinMonthPeriod,
  kinMoneyText,
  kinTotalsLines,
  kinTotalsText,
  type KinListFilter,
} from "./kinLists.ts";
import { kinCount } from "./kinCount.ts";

/**
 * The Money part of Work: what is owed to us, what came in and went out, and the year so far.
 * Every figure is the host's own, per currency, and says which entries are behind it.
 */

export const KIN_MONEY = {
  title: "Money",
  loadFailed: "Couldn't load Money",
  owed: "Owed to us",
  overdue: "Overdue",
  byClient: "Who owes us",
  noClient: "No client",
  nothingOwed: "Nobody owes you anything right now.",
  received: "Received",
  tdsDeducted: "TDS deducted",
  spent: "Spent",
  byCategory: "Spent by category",
  uncategorised: "No category",
  year: "This financial year",
  months: "The last 12 months",
  upcoming: "Coming-up dates",
  upcomingCount: (count: number) =>
    count === 1 ? "1 in the next 30 days" : `${count} in the next 30 days`,
  /** "₹2,50,000 in · ₹1,63,485 out". */
  monthSummary: (received: ReadonlyArray<string>, spent: ReadonlyArray<string>) =>
    `${received.join(" and ")} in · ${spent.join(" and ")} out`,
  add: "Add",
  newQuote: "Ask for a quote",
  rates: "Exchange rates",
  nothingUpcoming: "Nothing is due in the next 30 days.",
  allDates: "All dates",
  suggested: "Suggested by your agents",
  suggestedNote: KIN_SUGGESTION_NOTE,
  /** Past the newest shown, the rest of one list's suggestions: "12 more in Invoices". */
  suggestedMore: (count: number, listName: string) => `${count} more in ${listName}`,
  /** Past the clients a screen is sent, the rest, loaded on a tap. */
  clientsMore: (count: number) => (count === 1 ? "1 more client" : `${count} more clients`),
  clientsFewer: "Show fewer",
  lists: "Lists",
  clients: "Clients",
  none: {
    title: "Nothing is tracked here yet",
    detail:
      "Once an agent keeps your expenses and invoices, this shows who owes you, what came in and what went out.",
  },
  ask: "Ask an agent to start tracking expenses",
  /** Before the first agent exists, the way in is making one. */
  createChief: "Create Chief of staff",
  askMessage: "Start tracking our expenses and invoices.",
  onlyOwner: {
    title: "Money isn't open to you",
    detail: "Money is kept by whoever runs this Kin.",
  },
  /** A company made new records no money until its country is chosen (`countryNeeded`). */
  countryFirst: {
    title: "Choose your country",
    detail: "Choose your company's country first, so amounts, tax and dates read right.",
  },
  countryFirstMember: {
    title: "Not set up yet",
    detail: "An owner chooses the company's country first, so amounts, tax and dates read right.",
  },
  chooseCountry: "Open Company details",
  /** Cash in the bank, as one line, before Kin has any statement or recorded money to show. */
  noBank: "No bank statement yet",
};

/**
 * Money's blocks, top to bottom: who owes us, then this month against last, ahead of what is
 * suggested, the next 30 days and cash; the folded rows last.
 */
export const KIN_MONEY_BLOCKS = [
  "owed",
  "month",
  "suggested",
  "outlook",
  "cash",
  "folded",
] as const;
export type KinMoneyBlock = (typeof KIN_MONEY_BLOCKS)[number];

/** True when Kin has nothing about the bank to show: Money draws it as `noBank`, one line. */
export const kinCashEmpty = (cash: KinCash): boolean =>
  !cash.known &&
  cash.accounts.length === 0 &&
  cash.byCurrency.length === 0 &&
  cash.notOfRecord.length === 0 &&
  (cash.alertAccounts ?? []).length === 0 &&
  (cash.bankKnown?.through ?? null) === null;

/** The lists the host's summary is built from. Everything else about a list is its definition. */
const INVOICES = "invoices";
const EXPENSES = "expenses";

/** The lists Money already opens from its own figures, which Work's Lists leaves out. */
export const kinInMoney = (def: Pick<KinListDefinition, "list">): boolean =>
  def.list === INVOICES || def.list === EXPENSES || def.list === "quotes";

/** Kin's own money lists keep their settings for the computer: the books are set up there. */
export const kinListSettingsOnPhone = (def: Pick<KinListDefinition, "list" | "builtIn">) =>
  !def.builtIn && ![INVOICES, EXPENSES, "receipts", "quotes"].includes(def.list);

/** A list to open, already narrowed to the entries behind a figure. */
export interface KinListOpen {
  readonly list: KinListId;
  readonly filter: KinListFilter;
}

export interface KinMoneyFigure {
  readonly id: string;
  readonly label: string;
  /** One line per currency; a single "Nothing" with none. */
  readonly lines: ReadonlyArray<string>;
  /** "₹1,20,000 last month", "3 invoices". */
  readonly note: string | null;
  readonly late: boolean;
  /** Null when the list behind it isn't there to open. */
  readonly open: KinListOpen | null;
}

export interface KinMoneyClientView {
  readonly key: string;
  readonly name: string;
  readonly owed: ReadonlyArray<string>;
  /** "₹60,000 overdue by 45 days"; null with nothing overdue. */
  readonly overdue: string | null;
  readonly invoices: string;
  readonly open: KinListOpen | null;
}

export interface KinMoneyMonthView {
  readonly month: string;
  readonly label: string;
  readonly received: string;
  readonly spent: string;
  readonly openReceived: KinListOpen | null;
  readonly openSpent: KinListOpen | null;
}

/** An entry an agent suggested, for the owner to keep or decline where Money shows it. */
export interface KinMoneySuggestionView {
  readonly key: KinRecordKey;
  readonly rev: number;
  readonly title: string;
  readonly amount: string | null;
  /** "INV-2 · Invoices · Suggested · Orbit Dental Care". */
  readonly line: string;
}

export interface KinMoneyView {
  readonly empty: boolean;
  /** Empty for a teammate, and from an older host. */
  readonly suggested: ReadonlyArray<KinMoneySuggestionView>;
  /** Each list holding more suggestions than are shown, opened on its suggestions. */
  readonly suggestedMore: ReadonlyArray<{ readonly label: string; readonly open: KinListOpen }>;
  readonly owed: KinMoneyFigure;
  readonly overdue: KinMoneyFigure;
  readonly clients: ReadonlyArray<KinMoneyClientView>;
  /** The owing clients past those sent, as one row; null with none, and from an older host. */
  readonly clientsMore: string | null;
  /** "November 2026". */
  readonly monthLabel: string;
  readonly received: KinMoneyFigure;
  /** TDS clients deducted this month: it settled invoices, but no money came in. Null with none. */
  readonly tdsDeducted: KinMoneyFigure | null;
  readonly spent: KinMoneyFigure;
  readonly categories: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly amount: string;
    readonly open: KinListOpen | null;
  }>;
  /** "FY 2026–27, April to March", or "FY 2026, January to December". */
  readonly yearLabel: string;
  readonly yearReceived: KinMoneyFigure;
  readonly yearTdsDeducted: KinMoneyFigure | null;
  readonly yearSpent: KinMoneyFigure;
  /** One chart per currency that moved: amounts in different currencies never share an axis. */
  readonly charts: ReadonlyArray<KinChartSpec>;
  /** Newest first. */
  readonly months: ReadonlyArray<KinMoneyMonthView>;
}

const lines = (totals: KinMoneyTotals) =>
  totals.length === 0 ? [KIN_MONEY_NOTHING] : kinTotalsLines(totals);

/** The Money summary as the screen shows it. `lists` says which figures have entries to open. */
export function kinMoneyView(
  summary: KinMoneySummary,
  lists: ReadonlyArray<KinListDefinition>,
): KinMoneyView {
  // An archived list's entries still count, so its figures still open it, marked archived.
  const has = (id: string) => lists.find((def) => def.list === id);
  const invoices = has(INVOICES);
  const expenses = has(EXPENSES);
  const open = (
    def: KinListDefinition | undefined,
    filter: Partial<KinListFilter>,
  ): KinListOpen | null =>
    def === undefined
      ? null
      : // Opened from a figure, the list holds exactly what the figure counted.
        { list: def.list, filter: { ...KIN_LIST_DEFAULT_FILTER, kept: true, ...filter } };
  // Issued and not yet paid in full: the state the host counts as owed.
  const owing = { show: "waiting" as const };
  // Money out by the day it left the accounts: exactly what the host counts as spent.
  const spentIn = (spent: KinListFilter["spent"], category?: string | null) =>
    open(expenses, {
      show: "done",
      spent,
      ...(category === undefined ? {} : category === null ? { noCategory: true } : { category }),
    });
  const receivedIn = (paid: KinListFilter["paid"]) => open(invoices, { paid });
  const thisMonth = kinMonthPeriod(summary.thisMonth);
  const yearStart = summary.financialYearStartMonth ?? 4;
  const year = kinFinancialYearPeriod(summary.financialYear, yearStart);
  const currencies = [
    ...new Set(
      summary.series.flatMap((point) =>
        [...point.received, ...point.spent].map((money) => money.currency),
      ),
    ),
  ];
  const minorOf = (totals: KinMoneyTotals, currency: string) =>
    totals.find((money) => money.currency === currency)?.minor ?? 0;
  const nothing =
    summary.owed.invoices === 0 &&
    summary.upcomingTotal === 0 &&
    currencies.length === 0 &&
    summary.receivedThisFinancialYear.length === 0 &&
    summary.spentThisFinancialYear.length === 0 &&
    (summary.suggested ?? []).length === 0;
  return {
    empty: nothing && !lists.some((def) => !def.builtIn),
    suggested: (summary.suggested ?? []).map(({ record, listName }) => ({
      key: record.key,
      rev: record.rev,
      title: record.title,
      amount: record.amount === undefined ? null : kinMoneyText(record.amount),
      line: [record.key, listName, KIN_SUGGESTED, kinBilledName(record)]
        .filter((part) => part !== null)
        .join(" · "),
    })),
    suggestedMore: (summary.suggestedLists ?? []).flatMap(({ list, listName, count }) => {
      const shown = (summary.suggested ?? []).filter(({ record }) => record.list === list).length;
      return count > shown
        ? [
            {
              label: KIN_MONEY.suggestedMore(count - shown, listName),
              open: { list, filter: { ...KIN_LIST_DEFAULT_FILTER, kept: false } },
            },
          ]
        : [];
    }),
    owed: {
      id: "owed",
      label: KIN_MONEY.owed,
      lines: lines(summary.owed.total),
      note: summary.owed.invoices === 0 ? null : kinCount(summary.owed.invoices, "invoice"),
      late: false,
      open: open(invoices, owing),
    },
    overdue: {
      id: "overdue",
      label: KIN_MONEY.overdue,
      lines: lines(summary.owed.overdue),
      note:
        summary.owed.overdueInvoices === 0
          ? null
          : kinCount(summary.owed.overdueInvoices, "invoice"),
      late: summary.owed.overdueInvoices > 0,
      open: open(invoices, { ...owing, late: true }),
    },
    clients: summary.owed.byClient.map((client) => ({
      key: client.party?.key ?? "none",
      // The no-client group names the typed names it holds, when the host sends them.
      name: client.party?.title ?? client.billTo ?? KIN_MONEY.noClient,
      owed: lines(client.owed),
      overdue:
        client.oldestOverdueDays === null
          ? null
          : `${kinTotalsText(client.overdue)} overdue by ${kinCount(client.oldestOverdueDays, "day")}`,
      invoices: kinCount(client.invoices, "invoice"),
      open: open(invoices, {
        ...owing,
        ...(client.party === null
          ? { noParty: true }
          : { party: { key: client.party.key, title: client.party.title } }),
      }),
    })),
    clientsMore:
      (summary.owed.byClientMore ?? 0) === 0
        ? null
        : KIN_MONEY.clientsMore(summary.owed.byClientMore ?? 0),
    monthLabel: kinMonthLabel(summary.thisMonth),
    received: {
      id: "received",
      label: KIN_MONEY.received,
      lines: lines(summary.received.thisMonth),
      note: `${kinTotalsText(summary.received.lastMonth)} last month`,
      late: false,
      open: receivedIn(thisMonth),
    },
    tdsDeducted:
      summary.tdsDeducted === undefined ||
      summary.tdsDeducted.thisMonth.length + summary.tdsDeducted.lastMonth.length === 0
        ? null
        : {
            id: "tds",
            label: KIN_MONEY.tdsDeducted,
            lines: lines(summary.tdsDeducted.thisMonth),
            note: `${kinTotalsText(summary.tdsDeducted.lastMonth)} last month`,
            late: false,
            open: null,
          },
    spent: {
      id: "spent",
      label: KIN_MONEY.spent,
      lines: lines(summary.spent.thisMonth.total),
      note: `${kinTotalsText(summary.spent.lastMonth.total)} last month`,
      late: false,
      open: spentIn(thisMonth),
    },
    categories: summary.spent.thisMonth.byCategory.map((row) => ({
      key: row.category ?? "",
      label:
        row.category === null ? KIN_MONEY.uncategorised : kinCategoryLabel(row.category, expenses),
      amount: kinTotalsText(row.total),
      open: spentIn(thisMonth, row.category),
    })),
    yearLabel: `${kinFinancialYearLabel(summary.financialYear)}, ${kinFinancialYearMonths(yearStart)}`,
    yearReceived: {
      id: "year-received",
      label: KIN_MONEY.received,
      lines: lines(summary.receivedThisFinancialYear),
      note: null,
      late: false,
      open: receivedIn(year),
    },
    yearTdsDeducted:
      summary.tdsDeductedThisFinancialYear === undefined ||
      summary.tdsDeductedThisFinancialYear.length === 0
        ? null
        : {
            id: "year-tds",
            label: KIN_MONEY.tdsDeducted,
            lines: lines(summary.tdsDeductedThisFinancialYear),
            note: null,
            late: false,
            open: null,
          },
    yearSpent: {
      id: "year-spent",
      label: KIN_MONEY.spent,
      lines: lines(summary.spentThisFinancialYear),
      note: null,
      late: false,
      open: spentIn(year),
    },
    charts: currencies.map((currency) => ({
      chart: "bar" as const,
      title: "Money in and out" as KinChartSpec["title"],
      caption: (currencies.length > 1
        ? `The last 12 months, ${currency} only`
        : "The last 12 months") as KinChartSpec["title"],
      unit: { kind: "money" as const, currency },
      labelType: "month" as const,
      labels: summary.series.map((point) => point.month),
      series: [
        {
          name: KIN_MONEY.received,
          values: summary.series.map((point) => minorOf(point.received, currency)),
        },
        {
          name: KIN_MONEY.spent,
          values: summary.series.map((point) => minorOf(point.spent, currency)),
        },
      ],
      comparison: null,
    })),
    months: [...summary.series].reverse().map((point) => {
      const period = kinMonthPeriod(point.month);
      return {
        month: point.month,
        label: kinMonthLabel(point.month, true),
        received: kinTotalsText(point.received, "–"),
        spent: kinTotalsText(point.spent, "–"),
        openReceived: point.received.length === 0 ? null : receivedIn(period),
        openSpent: point.spent.length === 0 ? null : spentIn(period),
      };
    }),
  };
}

/** Work's one-line money headline: "₹2,10,000 owed to us · ₹60,000 overdue". Null with none. */
export function kinMoneyHeadline(summary: KinMoneySummary): ReadonlyArray<string> {
  return [
    ...(summary.owed.total.length === 0 ? [] : [`${kinTotalsText(summary.owed.total)} owed to us`]),
    ...(summary.owed.overdue.length === 0
      ? []
      : [`${kinTotalsText(summary.owed.overdue)} overdue`]),
    ...(summary.received.thisMonth.length === 0
      ? []
      : [`${kinTotalsText(summary.received.thisMonth)} received this month`]),
    ...(summary.spent.thisMonth.total.length === 0
      ? []
      : [`${kinTotalsText(summary.spent.thisMonth.total)} spent this month`]),
  ];
}

/** Which agent to ask about money: one whose name or domain says so, else the front door. */
export function kinMoneyAgent<
  Lead extends { readonly name: string; readonly domain: string; readonly retired?: unknown },
>(leads: ReadonlyArray<Lead>): Lead | null {
  const live = leads.filter((lead) => lead.retired === undefined);
  const named = (pattern: RegExp) =>
    live.find((lead) => pattern.test(`${lead.name} ${lead.domain}`));
  return named(/financ|account|money|books/i) ?? named(/chief/i) ?? live[0] ?? null;
}
