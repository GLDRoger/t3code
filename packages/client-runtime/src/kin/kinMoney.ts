import type {
  KinChartSpec,
  KinListDefinition,
  KinListId,
  KinMoneySummary,
  KinMoneyTotals,
} from "@t3tools/contracts";

import {
  KIN_LIST_DEFAULT_FILTER,
  KIN_MONEY_NOTHING,
  kinCategoryLabel,
  kinFinancialYearLabel,
  kinFinancialYearPeriod,
  kinMonthLabel,
  kinMonthPeriod,
  kinTotalsLines,
  kinTotalsText,
  type KinListFilter,
} from "./kinLists.ts";

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
  upcoming: "Due in the next 30 days",
  nothingUpcoming: "Nothing is due in the next 30 days.",
  allDates: "All dates",
  lists: "Lists",
  clients: "Clients",
  none: {
    title: "Nothing is tracked here yet",
    detail:
      "Once an agent keeps your expenses and invoices, this shows who owes you, what came in and what went out, to the rupee.",
  },
  ask: "Ask an agent to start tracking expenses",
  askMessage: "Start tracking our expenses and invoices.",
  onlyOwner: {
    title: "Not available",
    detail: "Money is kept by whoever runs this Kin.",
  },
};

/** The lists the host's summary is built from. Everything else about a list is its definition. */
const INVOICES = "invoices";
const EXPENSES = "expenses";

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

export interface KinMoneyView {
  readonly empty: boolean;
  readonly owed: KinMoneyFigure;
  readonly overdue: KinMoneyFigure;
  readonly clients: ReadonlyArray<KinMoneyClientView>;
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
  /** "FY 2026–27, April to March". */
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
const plural = (count: number, one: string) => (count === 1 ? `1 ${one}` : `${count} ${one}s`);

/** The Money summary as the screen shows it. `lists` says which figures have entries to open. */
export function kinMoneyView(
  summary: KinMoneySummary,
  lists: ReadonlyArray<KinListDefinition>,
): KinMoneyView {
  const has = (id: string) => lists.find((def) => def.list === id && def.archivedAt === null);
  const invoices = has(INVOICES);
  const expenses = has(EXPENSES);
  const open = (
    def: KinListDefinition | undefined,
    filter: Partial<KinListFilter>,
  ): KinListOpen | null =>
    def === undefined
      ? null
      : { list: def.list, filter: { ...KIN_LIST_DEFAULT_FILTER, ...filter } };
  // Issued and not yet paid in full: the state the host counts as owed.
  const owing = { show: "waiting" as const };
  // Paid expenses by their own date: what the host counts as spent.
  const spentIn = (period: KinListFilter["period"], category?: string | null) =>
    open(expenses, {
      show: "done",
      period,
      ...(category === undefined ? {} : category === null ? { noCategory: true } : { category }),
    });
  const receivedIn = (paid: KinListFilter["paid"]) => open(invoices, { paid });
  const thisMonth = kinMonthPeriod(summary.thisMonth);
  const year = kinFinancialYearPeriod(summary.financialYear);
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
    summary.upcoming.length === 0 &&
    currencies.length === 0 &&
    summary.receivedThisFinancialYear.length === 0 &&
    summary.spentThisFinancialYear.length === 0;
  return {
    empty: nothing && !lists.some((def) => !def.builtIn),
    owed: {
      id: "owed",
      label: KIN_MONEY.owed,
      lines: lines(summary.owed.total),
      note: summary.owed.invoices === 0 ? null : plural(summary.owed.invoices, "invoice"),
      late: false,
      open: open(invoices, owing),
    },
    overdue: {
      id: "overdue",
      label: KIN_MONEY.overdue,
      lines: lines(summary.owed.overdue),
      note:
        summary.owed.overdueInvoices === 0 ? null : plural(summary.owed.overdueInvoices, "invoice"),
      late: summary.owed.overdueInvoices > 0,
      open: open(invoices, { ...owing, late: true }),
    },
    clients: summary.owed.byClient.map((client) => ({
      key: client.party?.key ?? "none",
      name: client.party?.title ?? KIN_MONEY.noClient,
      owed: lines(client.owed),
      overdue:
        client.oldestOverdueDays === null
          ? null
          : `${kinTotalsText(client.overdue)} overdue by ${plural(client.oldestOverdueDays, "day")}`,
      invoices: plural(client.invoices, "invoice"),
      open: open(invoices, {
        ...owing,
        ...(client.party === null
          ? { noParty: true }
          : { party: { key: client.party.key, title: client.party.title } }),
      }),
    })),
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
    yearLabel: `${kinFinancialYearLabel(summary.financialYear)}, April to March`,
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
