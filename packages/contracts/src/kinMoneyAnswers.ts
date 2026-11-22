import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinTrimmedText } from "./kinChat.ts";
import { KinSacCode } from "./kinFinance.ts";
import {
  KinBankKnown,
  KinCurrency,
  KinDay,
  KinMoney,
  KinMoneyTotals,
  KinSignedMoney,
} from "./kinMoney.ts";
import { KinRecordKey } from "./kinWork.ts";

/**
 * What Money answers from the host's own sums: cash from confirmed statements, what is expected
 * in and out next, runway, budgets, and quotes turned into invoices. Owner only, on the server.
 */

/** Why a read statement gives no balance of record. */
export const KinStatementStanding = Schema.Literals([
  "not yet confirmed",
  "its totals don't check out",
  "its confirm was undone",
]);
export type KinStatementStanding = typeof KinStatementStanding.Type;

const AccountKind = Schema.Literals(["account", "card"]);
/** The available balance a bank alert mail printed, and when it was sent: the bank's figure then. */
export const KinCashAlert = Schema.Struct({ balance: KinSignedMoney, at: IsoDateTime });
export type KinCashAlert = typeof KinCashAlert.Type;
export const KinCashAccount = Schema.Struct({
  /** "HDFC Account ••1234". */
  label: Schema.String,
  kind: AccountKind,
  /** The bank's own closing balance on `on`. */
  balance: KinSignedMoney,
  on: KinDay,
  ageDays: NonNegativeInt,
  stale: Schema.Boolean,
  check: Schema.Literals(["adds_up", "off", "unchecked"]),
  /** Another confirmed statement has the same bank and last four digits, unlinked to this one. */
  cannotTellApart: Schema.Boolean,
  newerRead: Schema.NullOr(
    Schema.Struct({ balance: KinSignedMoney, on: KinDay, standing: KinStatementStanding }),
  ),
  /** A bank alert from after `on`: the balance shown. Absent from older hosts. */
  alert: Schema.optional(KinCashAlert),
});
export type KinCashAccount = typeof KinCashAccount.Type;

export const KinCashCurrency = Schema.Struct({
  currency: KinCurrency,
  accounts: NonNegativeInt,
  /** Null when two of its accounts can't be told apart. */
  total: Schema.NullOr(KinSignedMoney),
  /** The oldest balance's day: what is recorded after it counts as since. */
  since: KinDay,
  sameDay: Schema.Boolean,
  stale: Schema.Boolean,
  /** Recorded in Kin since, with no account known. */
  receivedSince: KinMoney,
  /** A refund lowers it. */
  spentSince: KinSignedMoney,
  /** Total plus received minus spent since, when every balance is from one day: an estimate. */
  estimate: Schema.NullOr(KinSignedMoney),
});
export type KinCashCurrency = typeof KinCashCurrency.Type;

export const KinCash = Schema.Struct({
  asOf: IsoDateTime,
  today: KinDay,
  timeZone: Schema.String,
  known: Schema.Boolean,
  accounts: Schema.Array(KinCashAccount),
  notOfRecord: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      kind: AccountKind,
      balance: KinSignedMoney,
      on: KinDay,
      standing: KinStatementStanding,
    }),
  ),
  byCurrency: Schema.Array(KinCashCurrency),
  /** Absent from older hosts. */
  bankKnown: Schema.optional(KinBankKnown),
  /** Accounts known only from bank alerts: "HDFC Bank ••4821". Absent from older hosts. */
  alertAccounts: Schema.optional(
    Schema.Array(Schema.Struct({ label: Schema.String, alert: KinCashAlert })),
  ),
});
export type KinCash = typeof KinCash.Type;
export const KinCashInput = Schema.Struct({ orgId: KinOrgId });
export type KinCashInput = typeof KinCashInput.Type;

export const KinOutlookItem = Schema.Struct({
  key: KinRecordKey,
  title: Schema.String,
  list: Schema.String,
  on: KinDay,
  money: KinSignedMoney,
  repeats: Schema.Boolean,
});
export type KinOutlookItem = typeof KinOutlookItem.Type;

export const KinRunway = Schema.Struct({
  currency: KinCurrency,
  months: Schema.Array(
    Schema.Struct({
      /** `2026-08`. */
      month: Schema.String,
      received: KinMoney,
      spent: KinSignedMoney,
      net: KinSignedMoney,
    }),
  ),
  averageNet: KinSignedMoney,
  balance: Schema.NullOr(
    Schema.Struct({ money: KinSignedMoney, oldest: KinDay, stale: Schema.Boolean }),
  ),
  /** Its accounts can't be told apart, so there is no balance to divide. */
  withheld: Schema.Boolean,
  /** Kin's records in this currency reach back three complete months. */
  enoughHistory: Schema.Boolean,
  historySince: Schema.NullOr(KinDay),
  /** Months of runway in tenths, or null when there is none to give. */
  runwayTenths: Schema.NullOr(NonNegativeInt),
});
export type KinRunway = typeof KinRunway.Type;

/** The next `days`: invoices due in, amounts owed and repeating bills out, and runway. */
export const KinOutlook = Schema.Struct({
  today: KinDay,
  days: PositiveInt,
  through: KinDay,
  expectedIn: KinMoneyTotals,
  expectedOut: KinMoneyTotals,
  net: Schema.Array(KinSignedMoney),
  /** The first of each, soonest first; `more*` counts the rest. */
  comingIn: Schema.Array(KinOutlookItem),
  moreComingIn: NonNegativeInt,
  goingOut: Schema.Array(KinOutlookItem),
  moreGoingOut: NonNegativeInt,
  /** Past-due amounts we owe: counted as going out. */
  pastDueOut: Schema.Array(KinOutlookItem),
  /** Overdue invoices: listed, never counted as coming in. */
  overdueIn: Schema.Array(KinOutlookItem),
  /** Keys of repeating entries that repeat more often than the host projects. */
  incomplete: Schema.Array(Schema.String),
  runway: Schema.Array(KinRunway),
});
export type KinOutlook = typeof KinOutlook.Type;
export const KinOutlookInput = Schema.Struct({ orgId: KinOrgId });
export type KinOutlookInput = typeof KinOutlookInput.Type;

const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/));
const BudgetCategory = KinTrimmedText.check(Schema.isMaxLength(80));
export const KinMoneyBudgetStatus = Schema.Literals(["ok", "near", "over"]);
export type KinMoneyBudgetStatus = typeof KinMoneyBudgetStatus.Type;
export const KinMoneyBudget = Schema.Struct({
  budgetId: Schema.String,
  category: Schema.NullOr(Schema.String),
  /** Null for a budget over every project; a removed project keeps its id and loses its key. */
  project: Schema.NullOr(
    Schema.Struct({ key: Schema.NullOr(KinRecordKey), title: Schema.NullOr(Schema.String) }),
  ),
  limit: KinMoney,
  spent: KinSignedMoney,
  expenses: NonNegativeInt,
  /** Over is past the limit; near is at it or past 80% of it. */
  status: KinMoneyBudgetStatus,
  /** Spending on the same target in other currencies, which `spent` leaves out; absent when none. */
  notCounted: Schema.optional(
    Schema.Array(Schema.Struct({ currency: KinCurrency, spent: KinSignedMoney })),
  ),
});
export type KinMoneyBudget = typeof KinMoneyBudget.Type;
export const KinMoneyBudgets = Schema.Struct({
  month: Month,
  budgets: Schema.Array(KinMoneyBudget),
});
export type KinMoneyBudgets = typeof KinMoneyBudgets.Type;
export const KinMoneyBudgetsInput = Schema.Struct({ orgId: KinOrgId });
export type KinMoneyBudgetsInput = typeof KinMoneyBudgetsInput.Type;
/** Sets a monthly limit on paid expenses for a category, a project, or both; null removes it. */
export const KinMoneyBudgetSetInput = Schema.Struct({
  orgId: KinOrgId,
  category: Schema.NullOr(BudgetCategory),
  project: Schema.NullOr(KinRecordKey),
  currency: KinCurrency,
  limitMinor: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinMoneyBudgetSetInput = typeof KinMoneyBudgetSetInput.Type;

/** One line an invoice or quote bills: quantity times rate, under its SAC or HSN code. */
export const KinDocumentLine = Schema.Struct({
  description: KinTrimmedText.check(Schema.isMaxLength(300)),
  sac: Schema.NullOr(KinSacCode),
  /** A decimal, such as `3` or `2.5`. */
  quantity: Schema.String.check(Schema.isPattern(/^\d{1,9}(\.\d{1,3})?$/)),
  unit: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(20)))),
  /** As said, such as "₹1,200": templates read amounts the way an agent gives them. */
  rate: Schema.String.check(Schema.isMaxLength(40)),
});
export type KinDocumentLine = typeof KinDocumentLine.Type;
export const KinEntryLinesInput = Schema.Struct({ orgId: KinOrgId, key: KinRecordKey });
export type KinEntryLinesInput = typeof KinEntryLinesInput.Type;
/** The lines the entry's latest document was made with; null when it had none Kin can read. */
export const KinEntryLines = Schema.Struct({ lines: Schema.NullOr(Schema.Array(KinDocumentLine)) });
export type KinEntryLines = typeof KinEntryLines.Type;

export const KinInvoiceFromQuoteInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  /** The same id again returns what that request made. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinInvoiceFromQuoteInput = typeof KinInvoiceFromQuoteInput.Type;
/** The draft invoice, once per quote, and its document made with the quote's lines. */
export const KinInvoiceFromQuoteResult = Schema.Struct({
  invoice: KinRecordKey,
  documents: Schema.Array(Schema.Struct({ key: KinRecordKey, title: Schema.String })),
  /** Why its document couldn't be made; the draft stands. */
  problems: Schema.Array(Schema.String),
});
export type KinInvoiceFromQuoteResult = typeof KinInvoiceFromQuoteResult.Type;

/**
 * An invoice typed by hand: a draft for the client, never numbered or owed until it is issued,
 * and its document made with these lines, which set its amount and tax.
 */
export const KinNewInvoiceInput = Schema.Struct({
  orgId: KinOrgId,
  client: KinRecordKey,
  title: KinTrimmedText.check(Schema.isMaxLength(280)),
  lines: Schema.Array(KinDocumentLine).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  /** GST percent, in India only; elsewhere the company's own tax applies. */
  gstRate: Schema.optional(
    Schema.String.check(Schema.isPattern(/^(?:100|\d{1,2}(?:\.\d{1,3})?)$/)),
  ),
  dueOn: Schema.optional(KinDay),
  notes: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  project: Schema.optional(KinRecordKey),
  /**
   * A form that can ask sends false: an amount far above its list is refused with the error's
   * `farAbove` for the person to confirm, and true saves it. Left out, nothing is asked.
   */
  amountConfirmed: Schema.optional(Schema.Boolean),
  /** The same id with the same details returns what that request made. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinNewInvoiceInput = typeof KinNewInvoiceInput.Type;

/** An expense typed by hand; the company's Expenses list is made the first time. */
export const KinNewExpenseInput = Schema.Struct({
  orgId: KinOrgId,
  title: KinTrimmedText.check(Schema.isMaxLength(280)),
  amount: KinMoney,
  paidOn: KinDay,
  /** Who was paid, as said. */
  vendor: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(200))),
  /** One of the Expenses list's own categories. */
  category: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(60))),
  /** One of its "Paid with" choices. */
  paidWith: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(60))),
  /** Files already in the person's chats (`kin.work.files`). */
  receipt: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(5)),
  ),
  /**
   * A form that can ask sends false: an amount far above its list is refused with the error's
   * `farAbove` for the person to confirm, and true saves it. Left out, nothing is asked.
   */
  amountConfirmed: Schema.optional(Schema.Boolean),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinNewExpenseInput = typeof KinNewExpenseInput.Type;
export const KinNewExpenseResult = Schema.Struct({ expense: KinRecordKey });
export type KinNewExpenseResult = typeof KinNewExpenseResult.Type;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinMoneyAnswerRpcs = [
  Rpc.make("kin.work.cash", { payload: KinCashInput, success: KinCash, error }),
  Rpc.make("kin.work.outlook", { payload: KinOutlookInput, success: KinOutlook, error }),
  Rpc.make("kin.work.budgets", {
    payload: KinMoneyBudgetsInput,
    success: KinMoneyBudgets,
    error,
  }),
  Rpc.make("kin.work.setBudget", {
    payload: KinMoneyBudgetSetInput,
    success: KinMoneyBudgets,
    error,
  }),
  Rpc.make("kin.work.entryLines", { payload: KinEntryLinesInput, success: KinEntryLines, error }),
  Rpc.make("kin.work.invoiceFromQuote", {
    payload: KinInvoiceFromQuoteInput,
    success: KinInvoiceFromQuoteResult,
    error,
  }),
  Rpc.make("kin.work.newInvoice", {
    payload: KinNewInvoiceInput,
    success: KinInvoiceFromQuoteResult,
    error,
  }),
  Rpc.make("kin.work.newExpense", {
    payload: KinNewExpenseInput,
    success: KinNewExpenseResult,
    error,
  }),
] as const;

export const KIN_MONEY_ANSWER_RPC_SCOPES = {
  "kin.work.cash": AuthKinChatScope,
  "kin.work.outlook": AuthKinChatScope,
  "kin.work.budgets": AuthKinChatScope,
  "kin.work.setBudget": AuthKinChatScope,
  "kin.work.entryLines": AuthKinChatScope,
  "kin.work.invoiceFromQuote": AuthKinChatScope,
  "kin.work.newInvoice": AuthKinChatScope,
  "kin.work.newExpense": AuthKinChatScope,
} as const;
