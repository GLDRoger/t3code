import {
  KinSacCode,
  type KinCash,
  type KinDocumentLine,
  type KinListDefinition,
  type KinMoney,
  type KinMoneyBudget,
  type KinMoneyBudgetSetInput,
  type KinMoneyBudgets,
  type KinOrgId,
  type KinMatchPartnerInput,
  type KinOutlook,
  type KinOutlookItem,
  type KinRecord,
  type KinRecordKey,
  type KinRecordLink,
  type KinRunway,
  type KinSignedMoney,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { kinEstimate, type KinRates } from "./kinCurrency.ts";
import {
  afterLabel,
  kinBankKnownText,
  kinCategoryLabel,
  kinMoneyText,
  kinParseMoney,
  kinRecordName,
  kinSuggestionText,
  kinTotalsLines,
} from "./kinLists.ts";
import { formatKinTime } from "./kinScreenState.ts";
import { kinWorkDueLabel, type KinWorkRef } from "./kinWork.ts";

/**
 * Money's cash, next 30 days, budgets and quotes as the owner reads them. Every figure is the
 * host's own, one per currency; this only words them, and adds a foreign one's "about ₹x".
 */

export const KIN_CASH = {
  title: "Cash in the bank",
  loadFailed: "Couldn't load cash",
  none: "No confirmed bank statement yet. Send one in a chat and confirm it on its card.",
  owedOnCard: "Owed on card",
  stale: (days: number) => `${days} days old`,
  newer: (on: string, amount: string) =>
    `A newer statement (${on}, ${amount}) is not yet confirmed. Confirm it on its card in chat.`,
  newerOff: (on: string) =>
    `A newer statement (${on}) doesn't add up, so it isn't counted. Ask an agent to read it again.`,
  newerUndone: (on: string) => `A newer statement (${on}) was confirmed, then undone.`,
  alertNote: (on: string, amount: string) =>
    `This is the available balance in the newest bank alert mail, not a confirmed statement. The last confirmed statement closed at ${amount} (${on}).`,
  alertOnly:
    "This is the available balance in the newest bank alert mail. No confirmed statement covers this account yet.",
  apart: (label: string) =>
    `Kin can't tell this apart from another ${label}. Upload the missing month's statement so the two link up.`,
  withheld: "No total: two accounts look the same.",
  total: (accounts: number) => (accounts === 1 ? "Balance" : `Total of ${accounts} accounts`),
  recorded: (day: string) => `Recorded in Kin since ${day} (account not known)`,
  in: "In",
  out: "Out",
  estimate: "Estimate now",
  estimateNote:
    "An estimate, not a bank figure: it assumes everything recorded went through these accounts.",
  notCounted: "Not counted yet",
  why: "Why?",
  hideWhy: "Hide",
  details: "Details",
  /** One short line beside the account; the whole sentence sits behind Why. */
  flag: {
    alert: "From a bank alert",
    apart: "Looks like another account",
    newer: "Newer statement to confirm",
    newerOff: "Newer statement doesn't add up",
    newerUndone: "Newer statement undone",
  },
  standing: {
    "not yet confirmed": "not yet confirmed",
    "its totals don't check out": "doesn't add up",
    "its confirm was undone": "confirm undone",
  },
};

export const KIN_OUTLOOK = {
  title: "Next 30 days",
  loadFailed: "Couldn't load the next 30 days",
  comingIn: "Coming in",
  goingOut: "Going out",
  net: "Net",
  nothing: "Nothing",
  empty: "Nothing is due in or out in the next 30 days.",
  repeats: "repeats",
  overdueIn: (count: number) =>
    count === 1
      ? "1 overdue invoice isn't counted as coming in."
      : `${count} overdue invoices aren't counted as coming in.`,
  pastDue: "Past due, counted as going out",
  more: (count: number) => `${count} more`,
  short: "Some bills repeat more often than Kin looks ahead, so going out may be short.",
  runway: "Runway",
  runwayMonths: (tenths: number, currency: string) =>
    `About ${(tenths / 10).toFixed(1)} months of ${currency} cash at the last three months' pace.`,
  needsHistory: "Runway needs three full months of history.",
  needsStatement: (currency: string) => `Runway needs a confirmed ${currency} bank statement.`,
  apart: (currency: string) => `No ${currency} runway: two accounts look the same.`,
  notRunningDown: (currency: string) =>
    `${currency} cash isn't running down: the last three months brought in at least what went out.`,
  partners: "Partners to name",
  partnerNote: (count: number, oldest: string) =>
    `${count} expense${count === 1 ? "" : "s"} they paid, since ${oldest}`,
  partnerOwed: (name: string) => `Owed back to ${name}`,
  partnerReturns: (name: string) => `Refunds ${name} holds, coming back`,
  unmatched: "An imported address no teammate is matched to yet",
  nameless: "Marked owed with no partner named",
  whoIsThis: "Who is this?",
  nothingMatched: "Nothing was left to match: Money is up to date.",
  matchMoved: "New expenses arrived since you opened this. Nothing was changed; look again.",
  unsaid: "Paid personally, not counted as owed yet",
  unsaidNote: (count: number, since: string) =>
    `${count} imported expense${count === 1 ? "" : "s"} since ${since}, counted as the company's own until you say`,
  sayWho: "Say who paid",
  sayTitle: (address: string) => `Who is ${address}?`,
  sayDetail: (count: number, amount: string) =>
    `An import says this address paid ${amount} across ${count} expense${count === 1 ? "" : "s"} from their own money. Until you say, Money counts them as the company's own spending.`,
  paidBy: "Teammate",
  pickPerson: "Pick a teammate",
  settledQuestion: "Has the company paid them back?",
  stillOwed: "Still owed",
  stillOwedHint: "Counted as going out now, and as spending on the day you pay them back.",
  paidBack: "Already paid back",
  paidBackHint: "Nothing in Money changes; each expense says who paid it.",
  confirm: "Confirm",
  cancel: "Cancel",
  saving: "Saving…",
};

export const KIN_BUDGETS = {
  title: "Budgets",
  loadFailed: "Couldn't load budgets",
  empty: "No budgets yet. Set a monthly limit on a category or a project.",
  add: "Set a budget",
  edit: "Change budget",
  remove: "Remove budget",
  removeTitle: "Remove this budget?",
  removeDetail: "Its expenses stay as they are; only the limit goes. You can set it again.",
  save: "Save budget",
  category: "Category",
  anyCategory: "Every category",
  project: "Project",
  anyProject: "Every project",
  limit: "Monthly limit",
  needsTarget: "Pick a category, a project, or both.",
  needsLimit: "Enter the monthly limit, like 50,000 or $200.",
  detail: "A monthly limit on paid expenses, in the currency you type.",
  near: "Near the limit",
  overBadge: "Over",
  over: (amount: string) => `${amount} over`,
  left: (amount: string) => `${amount} left`,
  of: (spent: string, limit: string) => `${spent} of ${limit}`,
  /** "+ €768 not counted in this USD budget". */
  notCounted: (amounts: ReadonlyArray<string>, currency: string) =>
    `+ ${amounts.join(" and ")} not counted in this ${currency} budget`,
  removedProject: "a removed project",
};

export const KIN_QUOTES = {
  title: "Quotes",
  loadFailed: "Couldn't load quotes",
  empty: "No quotes yet. Ask an agent to make one.",
  noneOpen: "No open quotes.",
  askMessage: "Make a quote for ",
  seeAll: "See all",
  noClient: "No client",
  validUntil: (day: string) => `Valid until ${day}`,
  expiredOn: (day: string) => `Expired ${day}`,
  states: {
    draft: "Draft",
    sent: "Sent",
    accepted: "Accepted",
    declined: "Declined",
    expired: "Expired",
  },
  makeInvoice: "Make invoice",
  makingInvoice: "Making the invoice…",
  invoiceMade: (key: string) => `Invoice ${key} made from this quote, with the same lines.`,
  invoiceProblems: "The draft invoice stands, but Kin couldn't make its PDF:",
  openInvoice: "Open invoice",
  invoicedAs: (key: string) => `Invoiced as ${key}.`,
  send: "Mark sent",
  sendTitle: "Mark this quote sent?",
  sendDetail: "It gets the next quote number, for good.",
  accept: "Mark accepted",
  decline: "Mark declined",
  unaccept: "Not accepted",
  undecline: "Undo declined",
};

export const KIN_LINES = {
  title: "Lines",
  detail: "What is billed, one row each. Leave empty to bill the amount as one line.",
  description: "What",
  sac: "SAC/HSN",
  quantity: "Qty",
  unit: "Unit",
  rate: "Rate",
  add: "Add line",
  remove: "Remove line",
  badSac: (row: number) => `Line ${row}: a SAC or HSN code is 4 to 8 digits.`,
  badQuantity: (row: number) => `Line ${row}: enter a quantity like 3 or 2.5.`,
  badRate: (row: number) => `Line ${row}: enter a rate like 25,000.`,
  noDescription: (row: number) => `Line ${row}: say what it is.`,
  mixed: "Every line is in the same currency as the invoice.",
};

const isSac = Schema.is(KinSacCode);

/** A balance or net, signed; exact to the paisa as the bank states it. */
const kinSignedText = (money: KinSignedMoney, paise = true) =>
  money.minor < 0
    ? `-${kinMoneyText({ minor: -money.minor, currency: money.currency }, paise)}`
    : kinMoneyText(money, paise);

const estimateOf = (money: KinSignedMoney, rates: KinRates | null) =>
  money.minor < 0
    ? (() => {
        const held = kinEstimate({ minor: -money.minor, currency: money.currency }, rates);
        return held === null ? null : `about -${held.text.replace(/^about /, "")}`;
      })()
    : (kinEstimate(money, rates)?.text ?? null);

// Cash

export interface KinCashAccountView {
  readonly id: string;
  readonly label: string;
  readonly card: boolean;
  readonly amount: string;
  readonly estimate: string | null;
  /** "On 30 Oct · 16 days old". */
  readonly when: string;
  readonly stale: boolean;
  /** The most pressing of `notes` in a few words, for the row itself. */
  readonly flag: string | null;
  /** What the owner should know or do about it, each a sentence. */
  readonly notes: ReadonlyArray<string>;
}

export interface KinCashCurrencyView {
  readonly currency: string;
  readonly totalLabel: string;
  readonly total: string | null;
  readonly totalEstimate: string | null;
  readonly recordedLabel: string;
  readonly received: string;
  readonly spent: string;
  /** Null when the balances aren't from one day, or have no total. */
  readonly estimate: string | null;
  readonly estimateAbout: string | null;
}

export interface KinCashView {
  readonly known: boolean;
  /** "Bank known to 31 Oct"; null from an older host, or where Money already says none is in. */
  readonly bank: string | null;
  readonly accounts: ReadonlyArray<KinCashAccountView>;
  readonly currencies: ReadonlyArray<KinCashCurrencyView>;
  /** Reads that aren't balances of record, apart from any account. */
  readonly notCounted: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

const onLabel = (day: string, now: Date) => kinWorkDueLabel(day, now);
// The flag already says "From a bank alert"; the line beside it says only when it was sent.
// @effect-diagnostics-next-line globalDate:off - the shared clock-and-day label takes a Date.
const alertAt = (at: string, now: Date) => formatKinTime(new Date(at), now);

export function kinCashView(cash: KinCash, rates: KinRates | null, now: Date): KinCashView {
  const accounts = cash.accounts.map((one, index): KinCashAccountView => {
    const newer = one.newerRead;
    const notes = [
      ...(one.cannotTellApart ? [KIN_CASH.apart(one.label)] : []),
      ...(newer === null
        ? []
        : [
            newer.standing === "not yet confirmed"
              ? KIN_CASH.newer(onLabel(newer.on, now), kinSignedText(newer.balance))
              : newer.standing === "its totals don't check out"
                ? KIN_CASH.newerOff(onLabel(newer.on, now))
                : KIN_CASH.newerUndone(onLabel(newer.on, now)),
          ]),
    ];
    const alert = one.alert;
    if (alert !== undefined)
      notes.push(KIN_CASH.alertNote(onLabel(one.on, now), kinSignedText(one.balance)));
    const flag = one.cannotTellApart
      ? KIN_CASH.flag.apart
      : newer === null
        ? alert === undefined
          ? null
          : KIN_CASH.flag.alert
        : newer.standing === "not yet confirmed"
          ? KIN_CASH.flag.newer
          : newer.standing === "its totals don't check out"
            ? KIN_CASH.flag.newerOff
            : KIN_CASH.flag.newerUndone;
    return {
      id: `${one.label}:${one.on}:${index}`,
      flag,
      label:
        one.kind === "card" ? `${one.label} · ${KIN_CASH.owedOnCard.toLowerCase()}` : one.label,
      card: one.kind === "card",
      amount: kinSignedText(alert?.balance ?? one.balance),
      estimate: estimateOf(alert?.balance ?? one.balance, rates),
      when:
        alert !== undefined
          ? alertAt(alert.at, now)
          : [onLabel(one.on, now), one.stale ? KIN_CASH.stale(one.ageDays) : null]
              .filter((part) => part !== null)
              .join(" · "),
      stale: alert === undefined && one.stale,
      notes,
    };
  });
  const alertOnly = (cash.alertAccounts ?? []).map((one, index): KinCashAccountView => ({
    id: `alert:${one.label}:${index}`,
    flag: KIN_CASH.flag.alert,
    label: one.label,
    card: false,
    amount: kinSignedText(one.alert.balance),
    estimate: estimateOf(one.alert.balance, rates),
    when: alertAt(one.alert.at, now),
    stale: false,
    notes: [KIN_CASH.alertOnly],
  }));
  return {
    known: cash.known || alertOnly.length > 0,
    // With no balance at all, Money's own line already says no statement is confirmed.
    bank:
      !cash.known && cash.bankKnown?.through === null
        ? null
        : kinBankKnownText(cash.bankKnown, now),
    accounts: [...accounts, ...alertOnly],
    currencies: cash.byCurrency.map((one) => ({
      currency: one.currency,
      totalLabel: KIN_CASH.total(one.accounts),
      total: one.total === null ? null : kinSignedText(one.total),
      totalEstimate: one.total === null ? null : estimateOf(one.total, rates),
      recordedLabel: KIN_CASH.recorded(onLabel(one.since, now)),
      received: kinSignedText(one.receivedSince),
      spent: kinSignedText(one.spentSince),
      estimate: one.estimate === null ? null : kinSignedText(one.estimate, false),
      estimateAbout: one.estimate === null ? null : estimateOf(one.estimate, rates),
    })),
    notCounted: cash.notOfRecord.map((one, index) => ({
      id: `${one.label}:${one.on}:${index}`,
      text: `${one.label}: ${kinSignedText(one.balance)} on ${onLabel(one.on, now)}, ${KIN_CASH.standing[one.standing]}.`,
    })),
  };
}

// Outlook

export interface KinOutlookRowView {
  readonly id: string;
  /** Null for a partner's balance: it sums their expenses and opens none. */
  readonly key: KinRecordKey | null;
  readonly title: string;
  /** "Invoices · 20 Nov · repeats". */
  readonly note: string;
  readonly amount: string;
  readonly estimate: string | null;
}

export interface KinOutlookView {
  readonly empty: boolean;
  readonly comingIn: ReadonlyArray<string>;
  readonly goingOut: ReadonlyArray<string>;
  readonly net: ReadonlyArray<string>;
  readonly estimates: ReadonlyMap<string, string>;
  readonly incoming: ReadonlyArray<KinOutlookRowView>;
  readonly outgoing: ReadonlyArray<KinOutlookRowView>;
  readonly more: { readonly incoming: number; readonly outgoing: number };
  readonly notes: ReadonlyArray<string>;
  readonly runway: ReadonlyArray<{ readonly currency: string; readonly text: string }>;
  /**
   * Who the company owes back. One no teammate is matched to yet has `match`: the import's address
   * to name a person for, or null for expenses marked owed with no partner at all.
   */
  readonly partners: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly amount: string;
    readonly note: string;
    readonly match: { readonly address: string | null; readonly seen: KinPartnerSeen } | null;
  }>;
  /** Imported addresses that paid personally, waiting for an owner to say who and whether owed. */
  readonly unsaid: ReadonlyArray<{
    readonly address: string;
    readonly amount: string;
    readonly expenses: number;
    readonly note: string;
    readonly seen: KinPartnerSeen;
  }>;
}

/** The expenses and totals a partner row showed; the host changes exactly those or nothing. */
export type KinPartnerSeen = NonNullable<KinMatchPartnerInput["seen"]>;

/** Runway in a line: the host's months when it has them, else plainly why not. */
export function kinRunwayText(one: KinRunway): string {
  if (one.runwayTenths !== null) return KIN_OUTLOOK.runwayMonths(one.runwayTenths, one.currency);
  if (!one.enoughHistory) return KIN_OUTLOOK.needsHistory;
  if (one.balance === null)
    return one.withheld
      ? KIN_OUTLOOK.apart(one.currency)
      : KIN_OUTLOOK.needsStatement(one.currency);
  return KIN_OUTLOOK.notRunningDown(one.currency);
}

export function kinOutlookView(
  outlook: KinOutlook,
  rates: KinRates | null,
  now: Date,
): KinOutlookView {
  const row =
    (side: string) =>
    (one: KinOutlookItem, index: number): KinOutlookRowView => ({
      id: `${side}:${one.key}:${one.on}:${index}`,
      key: one.key,
      title: one.title,
      note: [one.list, onLabel(one.on, now), one.repeats ? KIN_OUTLOOK.repeats : null]
        .filter((part) => part !== null)
        .join(" · "),
      amount: kinMoneyText(one.money),
      estimate: kinEstimate(one.money, rates)?.text ?? null,
    });
  const estimates = new Map<string, string>();
  for (const money of [...outlook.expectedIn, ...outlook.expectedOut]) {
    const about = kinEstimate(money, rates)?.text;
    if (about !== undefined) estimates.set(kinMoneyText(money), about);
  }
  for (const money of outlook.net) {
    const about = estimateOf(money, rates);
    if (about !== null) estimates.set(kinSignedText(money, false), about);
  }
  // A partner's balance in each currency is its own row, under the figure it counts in.
  const balances = (outlook.owedToPartners ?? []).flatMap((one) =>
    one.owed.map((money) => ({ one, money })),
  );
  const partnerRow = ({ one, money }: (typeof balances)[number]): KinOutlookRowView => {
    const shownMoney = money.minor < 0 ? { ...money, minor: -money.minor } : money;
    return {
      id: `partner:${one.personId ?? one.address ?? one.name}:${money.currency}`,
      key: null,
      title:
        money.minor < 0 ? KIN_OUTLOOK.partnerReturns(one.name) : KIN_OUTLOOK.partnerOwed(one.name),
      note:
        one.personId !== null
          ? KIN_OUTLOOK.partnerNote(one.expenses, afterLabel(onLabel(one.oldest, now)))
          : one.address === null
            ? KIN_OUTLOOK.nameless
            : KIN_OUTLOOK.unmatched,
      amount: kinMoneyText(shownMoney),
      estimate: kinEstimate(shownMoney, rates)?.text ?? null,
    };
  };
  const outgoing = [
    ...outlook.pastDueOut.map(row("out")),
    ...outlook.goingOut.map((one, index) => row("out")(one, outlook.pastDueOut.length + index)),
    ...balances.filter(({ money }) => money.minor > 0).map(partnerRow),
  ];
  return {
    empty:
      outlook.expectedIn.length === 0 &&
      outlook.expectedOut.length === 0 &&
      outlook.overdueIn.length === 0,
    comingIn: kinTotalsLines(outlook.expectedIn),
    goingOut: kinTotalsLines(outlook.expectedOut),
    net: outlook.net.map((one) => kinSignedText(one, false)),
    estimates,
    incoming: [
      ...outlook.comingIn.map(row("in")),
      ...balances.filter(({ money }) => money.minor < 0).map(partnerRow),
    ],
    outgoing,
    more: { incoming: outlook.moreComingIn, outgoing: outlook.moreGoingOut },
    notes: [
      ...(outlook.overdueIn.length === 0 ? [] : [KIN_OUTLOOK.overdueIn(outlook.overdueIn.length)]),
      ...(outlook.incomplete.length === 0 ? [] : [KIN_OUTLOOK.short]),
    ],
    runway: outlook.runway.map((one) => ({ currency: one.currency, text: kinRunwayText(one) })),
    // Only who still needs a person named: every balance is already a row above.
    partners: (outlook.owedToPartners ?? [])
      .filter((one) => one.personId === null)
      .map((one) => ({
        id: one.personId ?? `address:${one.address ?? one.name}`,
        name: one.name,
        amount: kinTotalsLines(one.owed).join(" + "),
        note:
          one.personId !== null
            ? KIN_OUTLOOK.partnerNote(one.expenses, afterLabel(onLabel(one.oldest, now)))
            : one.address === null
              ? KIN_OUTLOOK.nameless
              : KIN_OUTLOOK.unmatched,
        match:
          one.personId === null
            ? { address: one.address, seen: { entries: one.entries ?? [], totals: one.owed } }
            : null,
      })),
    unsaid: (outlook.partnersUnsaid ?? []).map((one) => ({
      address: one.address,
      amount: kinTotalsLines(one.total).join(" + "),
      expenses: one.expenses,
      note: KIN_OUTLOOK.unsaidNote(one.expenses, afterLabel(onLabel(one.oldest, now))),
      seen: { entries: one.entries ?? [], totals: one.total },
    })),
  };
}

// Budgets

export interface KinBudgetView {
  readonly id: string;
  readonly label: string;
  /** "₹12,000 of ₹10,000". */
  readonly spent: string;
  /** "₹2,000 over", "₹0 left". */
  readonly standing: string;
  readonly status: KinMoneyBudget["status"];
  /** Spent as a share of the limit, 0 to 1, for a bar. */
  readonly share: number;
  readonly estimate: string | null;
  /** Spending on it in other currencies, which `spent` leaves out. */
  readonly notCounted: string | null;
  readonly budget: KinMoneyBudget;
}

function kinBudgetLabel(
  budget: Pick<KinMoneyBudget, "category" | "project">,
  expenses: Pick<KinListDefinition, "categoryLabels"> | null,
) {
  const project =
    budget.project === null
      ? null
      : // The host names a project only while it is there, as the Projects list does.
        ((budget.project.key === null ? null : budget.project.title) ?? KIN_BUDGETS.removedProject);
  const category = budget.category === null ? null : kinCategoryLabel(budget.category, expenses);
  return [category, project].filter((part) => part !== null).join(" in ");
}

export function kinBudgetsView(
  view: KinMoneyBudgets,
  expenses: Pick<KinListDefinition, "categoryLabels"> | null,
  rates: KinRates | null,
): ReadonlyArray<KinBudgetView> {
  const order = { over: 0, near: 1, ok: 2 } as const;
  return [...view.budgets]
    .map((budget) => {
      const left = budget.limit.minor - budget.spent.minor;
      const text = (minor: number) => kinMoneyText({ minor, currency: budget.limit.currency });
      return {
        id: budget.budgetId,
        label: kinBudgetLabel(budget, expenses),
        spent: KIN_BUDGETS.of(kinMoneyText(budget.spent), kinMoneyText(budget.limit)),
        standing: left < 0 ? KIN_BUDGETS.over(text(-left)) : KIN_BUDGETS.left(text(left)),
        status: budget.status,
        share:
          budget.limit.minor <= 0
            ? 1
            : Math.max(0, Math.min(budget.spent.minor / budget.limit.minor, 1)),
        estimate: kinEstimate(budget.limit, rates)?.text ?? null,
        notCounted:
          budget.notCounted === undefined || budget.notCounted.length === 0
            ? null
            : KIN_BUDGETS.notCounted(
                budget.notCounted.map((one) => kinMoneyText(one.spent)),
                budget.limit.currency,
              ),
        budget,
      };
    })
    .sort((a, b) => order[a.status] - order[b.status]);
}

/** Budgets in a line: what is over or near first, else that all are within their limits. */
export function kinBudgetsSummary(views: ReadonlyArray<Pick<KinBudgetView, "status">>): string {
  const over = views.filter((one) => one.status === "over").length;
  const near = views.filter((one) => one.status === "near").length;
  if (over + near === 0)
    return views.length === 1 ? "1 within its limit" : `${views.length} within their limits`;
  return [over === 0 ? null : `${over} over`, near === 0 ? null : `${near} near the limit`]
    .filter((part) => part !== null)
    .join(", ");
}

export interface KinBudgetDraft {
  readonly category: string | null;
  /** The project with its name, which a project past the first page can only bring itself. */
  readonly project: KinWorkRef | null;
  readonly limit: string;
}

export const kinBudgetDraftOf = (budget: KinMoneyBudget | null): KinBudgetDraft => ({
  category: budget?.category ?? null,
  project:
    !budget?.project?.key || budget.project.title === null
      ? null
      : { key: budget.project.key, title: budget.project.title },
  limit: budget === null ? "" : kinMoneyText(budget.limit),
});

/** A budget as the host takes it, or why it can't be set yet. */
export function kinBudgetInput(
  orgId: KinOrgId,
  draft: KinBudgetDraft,
  homeCurrency: string,
  clientRequestId: string,
):
  | { readonly ok: true; readonly input: KinMoneyBudgetSetInput }
  | { readonly ok: false; readonly problem: string } {
  if (draft.category === null && draft.project === null)
    return { ok: false, problem: KIN_BUDGETS.needsTarget };
  const limit = kinParseMoney(draft.limit, homeCurrency);
  if (limit === null || limit.minor <= 0) return { ok: false, problem: KIN_BUDGETS.needsLimit };
  return {
    ok: true,
    input: {
      orgId,
      category: draft.category,
      project: draft.project?.key ?? null,
      currency: limit.currency,
      limitMinor: limit.minor,
      clientRequestId,
    },
  };
}

/** Removing one: the same target and currency with no limit. */
export const kinBudgetRemoval = (
  orgId: KinOrgId,
  budget: KinMoneyBudget,
  clientRequestId: string,
): KinMoneyBudgetSetInput | null =>
  budget.project !== null && budget.project.key === null
    ? null
    : {
        orgId,
        category: budget.category,
        project: budget.project?.key ?? null,
        currency: budget.limit.currency,
        limitMinor: null,
        clientRequestId,
      };

// Quotes

export const KIN_QUOTES_LIST = "quotes";
export type KinQuoteState = keyof typeof KIN_QUOTES.states;

/** A quote's standing: a sent one past its valid-until day has expired; a void one was declined. */
export function kinQuoteState(
  record: Pick<KinRecord, "state" | "dueAt">,
  now: Date,
): KinQuoteState {
  switch (record.state) {
    case "done":
      return "accepted";
    case "dropped":
      return "declined";
    case "waiting":
      return record.dueAt !== null && Date.parse(record.dueAt) < now.getTime() ? "expired" : "sent";
    default:
      return "draft";
  }
}

export interface KinQuoteRowView {
  readonly key: KinRecordKey;
  readonly number: string;
  readonly party: string;
  readonly title: string;
  readonly amount: string | null;
  readonly estimate: string | null;
  readonly state: KinQuoteState;
  readonly stateLabel: string;
  readonly when: string | null;
}

export function kinQuoteRow(record: KinRecord, rates: KinRates | null, now: Date): KinQuoteRowView {
  const state = kinQuoteState(record, now);
  const until = record.dueAt === null ? null : kinWorkDueLabel(record.dueAt.slice(0, 10), now);
  return {
    key: record.key,
    number: kinRecordName(record.key, record.fields?.number),
    party: record.party?.title ?? KIN_QUOTES.noClient,
    title: record.title,
    amount: record.amount === undefined ? null : kinMoneyText(record.amount),
    estimate:
      record.amount === undefined ? null : (kinEstimate(record.amount, rates)?.text ?? null),
    state,
    stateLabel: kinSuggestionText(record, KIN_QUOTES.states[state]),
    when:
      until === null
        ? null
        : state === "expired"
          ? KIN_QUOTES.expiredOn(until)
          : state === "sent" || state === "draft"
            ? KIN_QUOTES.validUntil(until)
            : null,
  };
}

/** What the owner may do on a quote now: each way in with its way back. */
/** Open quotes in a line: how many, and how many of them have expired. */
export function kinQuotesSummary(
  rows: ReadonlyArray<Pick<KinQuoteRowView, "state">>,
  total: number | null,
): string {
  const open = Math.max(total ?? 0, rows.length);
  if (open === 0) return KIN_QUOTES.noneOpen.replace(/\.$/, "");
  const expired = rows.filter((one) => one.state === "expired").length;
  return `${open} open${expired === 0 ? "" : `, ${expired} expired`}`;
}

const INVOICE_KEY = /^INV-\d+$/;

/** The invoice made from this quote, which the host links back to it; null until there is one. */
export function kinQuoteInvoice(links: ReadonlyArray<KinRecordLink>): KinRecordKey | null {
  for (const link of links)
    if (link.kind === "record" && link.record !== undefined && INVOICE_KEY.test(link.record.key))
      return link.record.key;
  return null;
}

/** A quote invoiced once offers its invoice, not another one. */
export function kinQuoteActions(state: KinQuoteState, numbered: boolean, invoiced = false) {
  return {
    send: state === "draft" && numbered,
    makeInvoice: state !== "declined" && !invoiced,
    accept: state === "draft" || state === "sent" || state === "expired",
    decline: state !== "declined" && state !== "accepted",
    unaccept: state === "accepted",
    undecline: state === "declined",
  };
}

// Invoice and quote lines

export interface KinLineDraft {
  readonly description: string;
  readonly sac: string;
  readonly quantity: string;
  readonly unit: string;
  readonly rate: string;
}

export const KIN_EMPTY_LINE: KinLineDraft = {
  description: "",
  sac: "",
  quantity: "1",
  unit: "",
  rate: "",
};

export const kinLineDrafts = (lines: ReadonlyArray<KinDocumentLine> | null): KinLineDraft[] =>
  (lines ?? []).map((line) => ({
    description: line.description,
    sac: line.sac ?? "",
    quantity: line.quantity,
    unit: line.unit ?? "",
    rate: line.rate,
  }));

const QUANTITY = /^\d{1,9}(\.\d{1,3})?$/;

/**
 * Lines as the template takes them, or the first problem. Rows left wholly empty are dropped; none
 * at all bills the entry's own amount as one line.
 */
export function kinLinesInput(
  drafts: ReadonlyArray<KinLineDraft>,
  currency: string,
):
  | { readonly ok: true; readonly lines: ReadonlyArray<KinDocumentLine> | null }
  | { readonly ok: false; readonly problem: string } {
  const filled = drafts.filter(
    (one) => one.description.trim() !== "" || one.sac.trim() !== "" || one.rate.trim() !== "",
  );
  const lines: KinDocumentLine[] = [];
  for (const [index, draft] of filled.entries()) {
    const row = index + 1;
    const description = draft.description.trim().replace(/\s+/g, " ");
    if (description === "") return { ok: false, problem: KIN_LINES.noDescription(row) };
    const sac = draft.sac.replace(/\s+/g, "");
    if (sac !== "" && !isSac(sac)) return { ok: false, problem: KIN_LINES.badSac(row) };
    const quantity = draft.quantity.trim();
    if (!QUANTITY.test(quantity) || !/[1-9]/.test(quantity))
      return { ok: false, problem: KIN_LINES.badQuantity(row) };
    const rate: KinMoney | null = kinParseMoney(draft.rate, currency);
    if (rate === null) return { ok: false, problem: KIN_LINES.badRate(row) };
    if (rate.currency !== currency) return { ok: false, problem: KIN_LINES.mixed };
    const unit = draft.unit.trim().slice(0, 20);
    lines.push({
      description: description.slice(0, 300),
      sac: sac === "" ? null : sac,
      quantity,
      ...(unit === "" ? {} : { unit }),
      rate: kinMoneyText(rate, true),
    });
  }
  return { ok: true, lines: lines.length === 0 ? null : lines };
}
