import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinTrimmedText } from "./kinChat.ts";
import { KinCurrency, KinDay, KinListId, KinMoney, KinMoneyTotals } from "./kinMoney.ts";
import {
  KinRecord,
  KinRecordDetail,
  KinRecordKey,
  KinRecordRef,
  KinRecordState,
} from "./kinWork.ts";

/**
 * Lists as configuration and the money they hold: list definitions, the cross-list dates view,
 * invoices' payments, the Money summary and the company profile. Owner only. Every figure is
 * computed by the server from integer minor units, one total per currency.
 */

export const KinListFieldType = Schema.Literals([
  "text",
  "choice",
  "date",
  "person",
  "link",
  "money",
  "file",
]);
export type KinListFieldType = typeof KinListFieldType.Type;
export const KinListFieldKey = Schema.String.check(Schema.isPattern(/^[a-z][a-zA-Z0-9]{0,39}$/));
export type KinListFieldKey = typeof KinListFieldKey.Type;
const Label = KinTrimmedText.check(Schema.isMaxLength(60));

/** One typed field of a list. A retired field keeps its values on entries and takes no new ones. */
export const KinListField = Schema.Struct({
  key: KinListFieldKey,
  label: Label,
  type: KinListFieldType,
  /** A choice field's options. */
  choices: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(30))),
  /** What a link field points at. */
  link: Schema.optional(Schema.Literals(["clients", "projects"])),
  /** Money fields always are. */
  sensitive: Schema.Boolean,
  retired: Schema.optional(Schema.Literal(true)),
});
export type KinListField = typeof KinListField.Type;

const KinStateLabels = Schema.Struct({
  open: Schema.optional(Label),
  doing: Schema.optional(Label),
  waiting: Schema.optional(Label),
  done: Schema.optional(Label),
  dropped: Schema.optional(Label),
});

export const KinListDefinition = Schema.Struct({
  list: KinListId,
  name: Label,
  /** Its entries' key prefix: `EXP` makes `EXP-31`. */
  prefix: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,5}$/)),
  /** Work and the light CRM: code depends on them and their shape is fixed. */
  builtIn: Schema.Boolean,
  /** Which of the five states it uses, and what it calls them. */
  states: Schema.Array(KinRecordState),
  stateLabels: KinStateLabels,
  defaultState: KinRecordState,
  categories: Schema.Array(Label),
  fields: Schema.Array(KinListField),
  /** New entries are labelled sensitive. */
  sensitive: Schema.Boolean,
  /** Its entries carry an amount, in `currency` unless they say otherwise. */
  amount: Schema.Boolean,
  currency: KinCurrency,
  /** What the entry's `dueAt` and `dateAt` are called here; absent when it has none. */
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
  archivedAt: Schema.NullOr(IsoDateTime),
  rev: NonNegativeInt,
  /** Entries that are neither done nor dropped. */
  open: NonNegativeInt,
});
export type KinListDefinition = typeof KinListDefinition.Type;

export const KinListsInput = Schema.Struct({
  orgId: KinOrgId,
  /** Also the archived ones. */
  archived: Schema.optional(Schema.Boolean),
});
export type KinListsInput = typeof KinListsInput.Type;
export const KinListsResult = Schema.Struct({ lists: Schema.Array(KinListDefinition) });
export type KinListsResult = typeof KinListsResult.Type;

/**
 * The owner's changes to a defined list, which never delete: archiving hides it and refuses new
 * entries, a retired field keeps its values. Each has its way back. Built-in lists are refused.
 */
export const KinListUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  list: KinListId,
  rev: NonNegativeInt,
  name: Schema.optional(Label),
  archived: Schema.optional(Schema.Boolean),
  retireFields: Schema.optional(Schema.Array(KinListFieldKey).check(Schema.isMaxLength(30))),
  restoreFields: Schema.optional(Schema.Array(KinListFieldKey).check(Schema.isMaxLength(30))),
});
export type KinListUpdateInput = typeof KinListUpdateInput.Type;

/** One entry on a day: its due date or its own date. An entry with both is on the list twice. */
export const KinDateRow = Schema.Struct({
  record: KinRecord,
  listName: Label,
  /** What its list calls its state. */
  stateLabel: Label,
  kind: Schema.Literals(["due", "date"]),
  /** What its list calls this date. */
  label: Label,
  at: IsoDateTime,
  allDay: Schema.Boolean,
});
export type KinDateRow = typeof KinDateRow.Type;

/** Everything with a date in `[from, to)`, across lists, soonest first. A calendar or agenda. */
export const KinDatesInput = Schema.Struct({
  orgId: KinOrgId,
  from: IsoDateTime,
  to: IsoDateTime,
  lists: Schema.optional(Schema.Array(KinListId).check(Schema.isMaxLength(20))),
  /** Neither done nor dropped. */
  open: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
});
export type KinDatesInput = typeof KinDatesInput.Type;
export const KinDatesResult = Schema.Struct({
  rows: Schema.Array(KinDateRow),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
  asOf: IsoDateTime,
});
export type KinDatesResult = typeof KinDatesResult.Type;

const KinSpent = Schema.Struct({
  total: KinMoneyTotals,
  /** Most spent first; `null` is uncategorised. */
  byCategory: Schema.Array(
    Schema.Struct({ category: Schema.NullOr(Label), total: KinMoneyTotals }),
  ),
});

/**
 * What the Money tab and the morning brief read, in the owner's time zone. Owed counts issued
 * invoices' balances; overdue those past due. Received is payments by the day paid; spent is
 * expenses by their date. Months run in the owner's zone; `financialYear` is April to March.
 */
export const KinMoneySummary = Schema.Struct({
  asOf: IsoDateTime,
  timeZone: Schema.String,
  /** `2026-11` and `2026-10`. */
  thisMonth: Schema.String,
  lastMonth: Schema.String,
  /** `FY2026-27`. */
  financialYear: Schema.String,
  owed: Schema.Struct({
    total: KinMoneyTotals,
    overdue: KinMoneyTotals,
    invoices: NonNegativeInt,
    overdueInvoices: NonNegativeInt,
    /** Most overdue first, then most owed; `party` null for invoices with no client. */
    byClient: Schema.Array(
      Schema.Struct({
        party: Schema.NullOr(KinRecordRef),
        owed: KinMoneyTotals,
        overdue: KinMoneyTotals,
        invoices: NonNegativeInt,
        /** Days since its oldest unpaid invoice fell due, when one has. */
        oldestOverdueDays: Schema.NullOr(NonNegativeInt),
      }),
    ),
  }),
  received: Schema.Struct({ thisMonth: KinMoneyTotals, lastMonth: KinMoneyTotals }),
  receivedThisFinancialYear: KinMoneyTotals,
  spent: Schema.Struct({ thisMonth: KinSpent, lastMonth: KinSpent }),
  spentThisFinancialYear: KinMoneyTotals,
  /** Open entries due or dated in the next 30 days, soonest first, at most 50. */
  upcoming: Schema.Array(KinDateRow),
  upcomingTotal: NonNegativeInt,
  /** The last 12 months, oldest first, this month last: money in and out, for a chart. */
  series: Schema.Array(
    Schema.Struct({ month: Schema.String, received: KinMoneyTotals, spent: KinMoneyTotals }),
  ),
});
export type KinMoneySummary = typeof KinMoneySummary.Type;
export const KinMoneySummaryInput = Schema.Struct({ orgId: KinOrgId });
export type KinMoneySummaryInput = typeof KinMoneySummaryInput.Type;

/** Money received against an invoice. Paying it in full marks it paid; it never overpays. */
export const KinPaymentInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  /** In the invoice's own currency. */
  amount: KinMoney,
  paidOn: KinDay,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** A retry with the same id records nothing more. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinPaymentInput = typeof KinPaymentInput.Type;
/** Takes a payment back; a paid invoice it leaves short is issued again. */
export const KinPaymentVoidInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  paymentId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinPaymentVoidInput = typeof KinPaymentVoidInput.Type;

const ProfileText = Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(500)));
/** India's 15-character GST number. */
export const KinGstin = Schema.String.check(
  Schema.isPattern(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/),
);
export const KinCompanyBank = Schema.Struct({
  accountName: ProfileText,
  accountNumber: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9A-Z]{6,34}$/))),
  ifsc: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{4}0[A-Z0-9]{6}$/))),
  bankName: ProfileText,
  branch: ProfileText,
  upi: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[\w.-]{2,256}@[A-Za-z]{2,64}$/))),
});
export type KinCompanyBank = typeof KinCompanyBank.Type;
const KinCompanyProfileFields = {
  legalName: ProfileText,
  tradeName: ProfileText,
  address: ProfileText,
  gstin: Schema.NullOr(KinGstin),
  pan: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{5}\d{4}[A-Z]$/))),
  /** The State the company supplies from, as a GST state code or name. */
  placeOfSupply: Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(60))),
  /** The services accounting code its invoices usually carry. */
  sac: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{4,8}$/))),
  bank: KinCompanyBank,
};
export const KinCompanyProfileData = Schema.Struct(KinCompanyProfileFields);
export type KinCompanyProfileData = typeof KinCompanyProfileData.Type;
/** The company's legal and bank details: sensitive, the owner's, read by agents only in his turns. */
export const KinCompanyProfile = Schema.Struct({
  ...KinCompanyProfileFields,
  rev: NonNegativeInt,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type KinCompanyProfile = typeof KinCompanyProfile.Type;
export const KinCompanyProfileInput = Schema.Struct({ orgId: KinOrgId });
export type KinCompanyProfileInput = typeof KinCompanyProfileInput.Type;
/** Only the fields given change; `null` clears one. A stale `rev` is a conflict. */
export const KinCompanyProfileSetInput = Schema.Struct({
  orgId: KinOrgId,
  rev: NonNegativeInt,
  legalName: Schema.optional(KinCompanyProfileFields.legalName),
  tradeName: Schema.optional(KinCompanyProfileFields.tradeName),
  address: Schema.optional(KinCompanyProfileFields.address),
  gstin: Schema.optional(KinCompanyProfileFields.gstin),
  pan: Schema.optional(KinCompanyProfileFields.pan),
  placeOfSupply: Schema.optional(KinCompanyProfileFields.placeOfSupply),
  sac: Schema.optional(KinCompanyProfileFields.sac),
  bank: Schema.optional(
    Schema.Struct({
      accountName: Schema.optional(KinCompanyBank.fields.accountName),
      accountNumber: Schema.optional(KinCompanyBank.fields.accountNumber),
      ifsc: Schema.optional(KinCompanyBank.fields.ifsc),
      bankName: Schema.optional(KinCompanyBank.fields.bankName),
      branch: Schema.optional(KinCompanyBank.fields.branch),
      upi: Schema.optional(KinCompanyBank.fields.upi),
    }),
  ),
});
export type KinCompanyProfileSetInput = typeof KinCompanyProfileSetInput.Type;

const KIN_FINANCE_WS_METHODS = {
  lists: "kin.work.lists",
  updateList: "kin.work.updateList",
  dates: "kin.work.dates",
  money: "kin.work.money",
  recordPayment: "kin.work.recordPayment",
  voidPayment: "kin.work.voidPayment",
  companyProfile: "kin.work.companyProfile",
  setCompanyProfile: "kin.work.setCompanyProfile",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only, on the server; a chat-only session is refused before any handler runs.
export const KinFinanceRpcs = [
  Rpc.make(KIN_FINANCE_WS_METHODS.lists, {
    payload: KinListsInput,
    success: KinListsResult,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.updateList, {
    payload: KinListUpdateInput,
    success: KinListDefinition,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.dates, {
    payload: KinDatesInput,
    success: KinDatesResult,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.money, {
    payload: KinMoneySummaryInput,
    success: KinMoneySummary,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.recordPayment, {
    payload: KinPaymentInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.voidPayment, {
    payload: KinPaymentVoidInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.companyProfile, {
    payload: KinCompanyProfileInput,
    success: KinCompanyProfile,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.setCompanyProfile, {
    payload: KinCompanyProfileSetInput,
    success: KinCompanyProfile,
    error,
  }),
] as const;

export const KIN_FINANCE_RPC_SCOPES = {
  [KIN_FINANCE_WS_METHODS.lists]: AuthOrchestrationReadScope,
  // What a list is, like what a lead is for, is an owner setting.
  [KIN_FINANCE_WS_METHODS.updateList]: AuthSettingsWriteScope,
  [KIN_FINANCE_WS_METHODS.dates]: AuthOrchestrationReadScope,
  [KIN_FINANCE_WS_METHODS.money]: AuthOrchestrationReadScope,
  [KIN_FINANCE_WS_METHODS.recordPayment]: AuthOrchestrationOperateScope,
  [KIN_FINANCE_WS_METHODS.voidPayment]: AuthOrchestrationOperateScope,
  // Bank details: read and written only where owner settings are.
  [KIN_FINANCE_WS_METHODS.companyProfile]: AuthSettingsWriteScope,
  [KIN_FINANCE_WS_METHODS.setCompanyProfile]: AuthSettingsWriteScope,
} as const;
