import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError, AuthKinChatScope } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinLabelText, KinOrgId, KinTrimmedText } from "./kinChat.ts";
import { KIN_DEFAULT_HOME_CURRENCY } from "./kinCurrency.ts";
import {
  KinCurrency,
  KinDay,
  KinFileRef,
  KinListFieldKey,
  KinListId,
  KinMoney,
  KinMoneyAbout,
  KinMoneyTotals,
} from "./kinMoney.ts";
import {
  KinGstin,
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

export const KinWritableListFieldType = Schema.Literals([
  "text",
  "choice",
  "date",
  "person",
  "link",
  "money",
  "file",
]);
export const KinListFieldType = Schema.Literals([
  ...KinWritableListFieldType.literals,
  "number",
  "yesno",
]);
export type KinListFieldType = typeof KinListFieldType.Type;
export { KinListFieldKey };
const Label = KinLabelText.check(Schema.isMaxLength(60));

/** One typed field of a list. A retired field keeps its values on entries and takes no new ones. */
export const KinListField = Schema.Struct({
  key: KinListFieldKey,
  label: Label,
  type: KinListFieldType,
  /** A choice field's options. */
  choices: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(30))),
  /** What a link field points at. */
  link: Schema.optional(Schema.Literals(["clients", "projects", "list"])),
  linkList: Schema.optional(Schema.String),
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

/**
 * How a list numbers what it issues (CGST Rule 46(b)): a prefix, a series per Indian financial
 * year or one running series, and the digits the count is padded to, such as `KIN/26-27/014`.
 * The server issues a number when an entry is issued, never at draft; it is never reused.
 */
export const KinNumberingRule = Schema.Struct({
  prefix: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,8}$/)),
  series: Schema.Literals(["financial_year", "running"]),
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(6)),
});
export type KinNumberingRule = typeof KinNumberingRule.Type;

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
  /** How a category reads where that differs from how it is stored: `gst` as `GST`. */
  categoryLabels: Schema.optional(Schema.Record(Schema.String, Label)),
  fields: Schema.Array(KinListField),
  remindOn: Schema.optional(KinListFieldKey),
  /**
   * One check on every entry: a number field below or above another number field or a fixed
   * number. Sent only to a caller that accepts `check`, which reads one of `below` and `above`.
   */
  check: Schema.optional(
    Schema.Struct({
      field: KinListFieldKey,
      below: Schema.optional(Schema.Union([KinListFieldKey, Schema.Finite])),
      above: Schema.optional(Schema.Union([KinListFieldKey, Schema.Finite])),
    }),
  ),
  /** New entries are labelled sensitive. */
  sensitive: Schema.Boolean,
  team: Schema.optional(Schema.Boolean),
  teamSince: Schema.optional(Schema.NullOr(NonNegativeInt)),
  /** Its entries carry an amount, in `currency` unless they say otherwise. */
  amount: Schema.Boolean,
  currency: KinCurrency,
  /** Its entries are paid over time: each keeps its payments and a balance, as invoices do. */
  payments: Schema.optional(Schema.Literal(true)),
  /** What the entry's `dueAt` and `dateAt` are called here; absent when it has none. */
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
  /** Its entries get a number from the server when issued. */
  numbering: Schema.optional(KinNumberingRule),
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
  /** The later field types and features this caller can read. */
  accept: Schema.optional(Schema.Array(Schema.String)),
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
  /** What the list calls the states it uses; only the ones given change. */
  stateLabels: Schema.optional(KinStateLabels),
  /** By category as stored; only the ones given change, and `null` shows it as stored again. */
  categoryLabels: Schema.optional(
    Schema.Record(Schema.String, Schema.NullOr(Label)).check(Schema.isMaxProperties(30)),
  ),
  /**
   * Whether entries are paid over time. Needs a list with amounts; turning it off is refused
   * while an entry has a payment that counts, and Invoices always are.
   */
  payments: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  team: Schema.optional(Schema.Boolean),
  retireFields: Schema.optional(Schema.Array(KinListFieldKey).check(Schema.isMaxLength(30))),
  restoreFields: Schema.optional(Schema.Array(KinListFieldKey).check(Schema.isMaxLength(30))),
  /** Sets how it numbers what it issues from now on; numbers already issued stay. */
  numbering: Schema.optional(KinNumberingRule),
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
  /** The list's own date field this row is for; absent for the entry's due date and date. */
  field: Schema.optional(Schema.String),
  at: IsoDateTime,
  allDay: Schema.Boolean,
});
export type KinDateRow = typeof KinDateRow.Type;
/** Only a due day can be late; an entry's own day, such as an invoice's issue day, never is. */
export const kinDateRowLate = (row: KinDateRow) => row.kind === "due" && row.record.late;

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
 * expenses by their date. Months run in the owner's zone; `financialYear` starts in the company's month.
 */
export const KinMoneySummary = Schema.Struct({
  asOf: IsoDateTime,
  timeZone: Schema.String,
  /** `2026-11` and `2026-10`. */
  thisMonth: Schema.String,
  lastMonth: Schema.String,
  /** `FY2026-27`, or `FY2026` for a year that starts in January. */
  financialYear: Schema.String,
  /** The month the company's financial year starts in, 1 to 12; absent from older servers (April). */
  financialYearStartMonth: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  ),
  owed: Schema.Struct({
    total: KinMoneyTotals,
    overdue: KinMoneyTotals,
    invoices: NonNegativeInt,
    overdueInvoices: NonNegativeInt,
    /** Longest overdue first, then most owed; invoices without a client share one null group. */
    byClient: Schema.Array(
      Schema.Struct({
        party: Schema.NullOr(KinRecordRef),
        billTo: Schema.optional(Schema.String),
        owed: KinMoneyTotals,
        overdue: KinMoneyTotals,
        invoices: NonNegativeInt,
        /** Days since its oldest unpaid invoice fell due, when one has. */
        oldestOverdueDays: Schema.NullOr(NonNegativeInt),
      }),
    ),
    /** Owing clients past the first 20 a screen is sent, when there are more; absent otherwise. */
    byClientMore: Schema.optional(NonNegativeInt),
  }),
  /** Money paid in: tax a client deducted at source settles an invoice but isn't counted here. */
  received: Schema.Struct({ thisMonth: KinMoneyTotals, lastMonth: KinMoneyTotals }),
  receivedThisFinancialYear: KinMoneyTotals,
  /** TDS clients deducted from invoice payments, by the day paid; absent from older servers. */
  tdsDeducted: Schema.optional(
    Schema.Struct({ thisMonth: KinMoneyTotals, lastMonth: KinMoneyTotals }),
  ),
  tdsDeductedThisFinancialYear: Schema.optional(KinMoneyTotals),
  spent: Schema.Struct({ thisMonth: KinSpent, lastMonth: KinSpent }),
  spentThisFinancialYear: KinMoneyTotals,
  /** Open entries due or dated in the next 30 days, soonest first, at most 50. */
  upcoming: Schema.Array(KinDateRow),
  upcomingTotal: NonNegativeInt,
  /**
   * Money an agent suggested that the owner or a co-owner hasn't confirmed, newest first, at most
   * 20: counted in no figure here. Owner-level readers only; absent from older servers.
   */
  suggested: Schema.optional(Schema.Array(Schema.Struct({ record: KinRecord, listName: Label }))),
  /** Every such suggestion, counted by its list, most first: the rest open from here. */
  suggestedLists: Schema.optional(
    Schema.Array(Schema.Struct({ list: KinListId, listName: Label, count: NonNegativeInt })),
  ),
  /** The last 12 months, oldest first, this month last: money in and out, for a chart. */
  series: Schema.Array(
    Schema.Struct({ month: Schema.String, received: KinMoneyTotals, spent: KinMoneyTotals }),
  ),
  /** Beside each figure in more than one currency, its estimate; absent from older servers. */
  about: Schema.optional(
    Schema.Struct({
      owed: Schema.optional(KinMoneyAbout),
      overdue: Schema.optional(KinMoneyAbout),
      receivedThisMonth: Schema.optional(KinMoneyAbout),
      receivedLastMonth: Schema.optional(KinMoneyAbout),
      spentThisMonth: Schema.optional(KinMoneyAbout),
      spentLastMonth: Schema.optional(KinMoneyAbout),
    }),
  ),
});
export type KinMoneySummary = typeof KinMoneySummary.Type;
export const KinMoneySummaryInput = Schema.Struct({
  orgId: KinOrgId,
  /** `false` answers `upcoming` empty, `upcomingTotal` still counted: for screens that draw only the count. */
  upcomingRows: Schema.optional(Schema.Boolean),
  /** One client's page: what is owed is that client's alone, and none to a teammate without Money. */
  party: Schema.optional(KinRecordKey),
  /** Every owing client in `owed.byClient`, not the first 20 and a count of the rest. */
  allClients: Schema.optional(Schema.Boolean),
});
export type KinMoneySummaryInput = typeof KinMoneySummaryInput.Type;

/**
 * Money paid against an invoice, or an entry of any list paid over time. Paying it in full marks
 * it paid; it never overpays.
 */
export const KinPaymentInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  /** In the entry's own currency. */
  amount: KinMoney,
  paidOn: KinDay,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** Tax the client deducted at source (TDS), recorded with the cash; an amount of 0 is TDS alone. */
  tds: Schema.optional(KinMoney),
  /** A retry with the same id records nothing more. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinPaymentInput = typeof KinPaymentInput.Type;
/** Takes a payment back; a paid entry it leaves short is owed again. */
export const KinPaymentVoidInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  paymentId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinPaymentVoidInput = typeof KinPaymentVoidInput.Type;

/**
 * A receipt: money received, numbered in its own series. Against an invoice's payment, or an
 * advance received before any invoice, later set against one (`invoice` then names it).
 */
export const KinReceipt = Schema.Struct({
  key: KinRecordKey,
  number: Schema.NullOr(TrimmedNonEmptyString),
  state: KinRecordState,
  receivedOn: Schema.NullOr(KinDay),
  amount: Schema.NullOr(KinMoney),
  receivedFrom: Schema.NullOr(KinRecordRef),
  towards: Schema.NullOr(Schema.String),
  mode: Schema.NullOr(Schema.String),
  reference: Schema.NullOr(Schema.String),
  invoice: Schema.NullOr(KinRecordKey),
  /** The issued number of `invoice` (INV/26-27/001), null while it has none. */
  invoiceNumber: Schema.NullOr(Schema.String),
  paymentId: Schema.NullOr(TrimmedNonEmptyString),
  /** True when it was received before it was set against an invoice. */
  advance: Schema.Boolean,
  document: Schema.NullOr(Schema.Struct({ key: KinRecordKey, title: KinTrimmedText })),
});
export type KinReceipt = typeof KinReceipt.Type;
export const KinReceiptsInput = Schema.Struct({
  orgId: KinOrgId,
  /** Newest first; default 100. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type KinReceiptsInput = typeof KinReceiptsInput.Type;
export const KinReceiptsResult = Schema.Struct({ receipts: Schema.Array(KinReceipt) });
export type KinReceiptsResult = typeof KinReceiptsResult.Type;
/**
 * Makes a receipt, numbered and with its PDF: for a payment recorded on an invoice (a number the
 * old system gave it, in its note, is kept), or for a receipts entry such as an advance. With
 * `against`, an advance is set against that invoice as a payment. Retries return the same receipt.
 */
export const KinMakeReceiptInput = Schema.Struct({
  orgId: KinOrgId,
  paymentId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  key: Schema.optional(KinRecordKey),
  /** Money received before any invoice: a new receipt from the client, towards some work. */
  advance: Schema.optional(
    Schema.Struct({ client: Schema.optional(KinRecordKey), amount: KinMoney, receivedOn: KinDay }),
  ),
  against: Schema.optional(KinRecordKey),
  towards: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(300))),
  mode: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(40))),
  reference: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(120))),
  /** A retry with the same id returns the same receipt. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinMakeReceiptInput = typeof KinMakeReceiptInput.Type;
export const KinMakeReceiptResult = Schema.Struct({
  receipt: KinReceipt,
  /** Why its PDF couldn't be made; the receipt and its number stand either way. */
  problems: Schema.Array(Schema.String),
});
export type KinMakeReceiptResult = typeof KinMakeReceiptResult.Type;

/** A file the owner can keep on an entry: one on a message in a chat the owner is in. */
export const KinWorkFile = Schema.Struct({ ...KinFileRef.fields, sentAt: IsoDateTime });
export type KinWorkFile = typeof KinWorkFile.Type;
/** Files in the owner's chats, newest first, for attaching one to an entry. */
export const KinWorkFilesInput = Schema.Struct({
  orgId: KinOrgId,
  /** Case-insensitive match on the file's name. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type KinWorkFilesInput = typeof KinWorkFilesInput.Type;
export const KinWorkFilesResult = Schema.Struct({
  files: Schema.Array(KinWorkFile),
  nextCursor: Schema.NullOr(Schema.String),
});
export type KinWorkFilesResult = typeof KinWorkFilesResult.Type;
/**
 * Issues an entry of a numbered list: the server gives it the next number in its series, in
 * one transaction, and marks it issued. Issuing an issued entry returns the number it has.
 */
export const KinIssueInput = Schema.Struct({ orgId: KinOrgId, key: KinRecordKey });
export type KinIssueInput = typeof KinIssueInput.Type;
/**
 * Voids an entry: kept, with its number if it had one, so the series stays complete. `unvoid`
 * takes it back: owed again, or paid if its payments cover it. A void receipt stays void.
 */
export const KinVoidInput = Schema.Struct({ orgId: KinOrgId, key: KinRecordKey });
export type KinVoidInput = typeof KinVoidInput.Type;
export const KinIssueResult = Schema.Struct({
  key: KinRecordKey,
  /** `null` for a voided draft, which never had one. */
  number: Schema.NullOr(TrimmedNonEmptyString),
  state: KinRecordState,
  /** True when this call issued it; false when it already had its number. */
  issued: Schema.Boolean,
  /** Its documents, made again in place with the number when this call issued it. */
  documents: Schema.Array(
    Schema.Struct({ key: KinRecordKey, title: KinTrimmedText, version: Schema.Number }),
  ),
  /** Why a document couldn't be made again; the number stands either way. */
  problems: Schema.Array(Schema.String),
  /** Said plainly when its number follows entries dated after it, as a backdated one's does. */
  notice: Schema.optional(Schema.String),
});
export type KinIssueResult = typeof KinIssueResult.Type;
/** The number Issue would give the entry now; another issue first may take it. */
export const KinNextNumberResult = Schema.Struct({
  /** `null` when it has one already or its list doesn't number its entries. */
  number: Schema.NullOr(TrimmedNonEmptyString),
});
export type KinNextNumberResult = typeof KinNextNumberResult.Type;

const ProfileText = Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(500)));
export const KinCompanyBank = Schema.Struct({
  accountName: ProfileText,
  accountNumber: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9A-Z]{6,34}$/))),
  ifsc: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{4}0[A-Z0-9]{6}$/))),
  bankName: ProfileText,
  branch: ProfileText,
  upi: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[\w.-]{2,256}@[A-Za-z]{2,64}$/))),
});
export type KinCompanyBank = typeof KinCompanyBank.Type;
/** Logo files a recipe may show: drawn as sent, never re-encoded. */
const KIN_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;
/** The company's logo: Kin's own copy of an image the owner sent, kept with the profile. */
export const KinCompanyLogo = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: KinTrimmedText.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals(KIN_LOGO_MIME_TYPES),
  bytes: NonNegativeInt,
  /** In pixels; `null` for an SVG with no size of its own. */
  width: Schema.NullOr(NonNegativeInt),
  height: Schema.NullOr(NonNegativeInt),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type KinCompanyLogo = typeof KinCompanyLogo.Type;
/** Fonts every recipe can use: Typst's own and the open-licence ones Kin fetches. */
export const KIN_RECIPE_FONTS = [
  "Poppins",
  "Mukta",
  "Libertinus Serif",
  "New Computer Modern",
  "DejaVu Sans Mono",
] as const;
const BrandColor = Schema.NullOr(Schema.String.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/)));
/** How the company's documents look where a recipe asks: colours, a font and a footer line. */
export const KinCompanyBrand = Schema.Struct({
  primaryColor: BrandColor,
  secondaryColor: BrandColor,
  font: Schema.NullOr(Schema.Literals(KIN_RECIPE_FONTS)),
  footer: Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(300))),
});
export type KinCompanyBrand = typeof KinCompanyBrand.Type;
const NO_BRAND: KinCompanyBrand = {
  primaryColor: null,
  secondaryColor: null,
  font: null,
  footer: null,
};
/**
 * A rate the owner set: `rate` units of the home currency for one unit of `currency`, as of a day.
 * Only for "about ₹x" beside a foreign amount; never in an exact figure, invoice or export.
 */
export const KinCurrencyRate = Schema.Struct({
  currency: KinCurrency,
  rate: Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/)),
  asOf: KinDay,
});
export type KinCurrencyRate = typeof KinCurrencyRate.Type;
const KinCurrencyRates = Schema.Array(KinCurrencyRate).check(
  Schema.isMaxLength(20),
  Schema.makeFilter(
    (rates: ReadonlyArray<KinCurrencyRate>) =>
      new Set(rates.map((one) => one.currency)).size === rates.length &&
      rates.every((one) => /[1-9]/.test(one.rate)),
    { expected: "one rate above zero per currency" },
  ),
);
/** A country as ISO 3166 alpha-2 writes it: `IN`, `GB`, `US`. */
export const KinCountryCode = Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/));
/** The month a financial year starts in: 1 for January. */
export const KinMonthNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }));
/** The one tax the company charges on what it sells outside India, such as VAT at 20 percent. */
export const KinCompanyTax = Schema.Struct({
  name: KinTrimmedText.check(Schema.isMaxLength(40)),
  /** A percent, such as "20" or "7.5"; null charges none until it is set. */
  rate: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(?:100|\d{1,2}(?:\.\d{1,3})?)$/))),
  /** Whether the prices it is charged on already include it. */
  pricesInclude: Schema.NullOr(Schema.Boolean),
});
export type KinCompanyTax = typeof KinCompanyTax.Type;
/** A SAC or HSN code as GST writes it: 4 to 8 digits. */
export const KinSacCode = Schema.String.check(Schema.isPattern(/^\d{4,8}$/));
const KinCompanyProfileFields = {
  legalName: ProfileText,
  tradeName: ProfileText,
  address: ProfileText,
  gstin: Schema.NullOr(KinGstin),
  pan: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{5}\d{4}[A-Z]$/))),
  /** The State the company supplies from, as a GST state code or name. */
  placeOfSupply: Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(60))),
  /** The services accounting code its invoices usually carry. */
  sac: Schema.NullOr(KinSacCode),
  bank: KinCompanyBank,
  /** The letter of undertaking exports go under without IGST: its ARN, and the day it was filed. */
  lutNumber: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z0-9]{8,20}$/))),
  ),
  lutDate: Schema.optional(Schema.NullOr(KinDay)),
  // Profiles stored before the logo and brand existed read as having neither.
  logo: Schema.NullOr(KinCompanyLogo).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  brand: KinCompanyBrand.pipe(Schema.withDecodingDefaultKey(Effect.succeed(NO_BRAND))),
  /** What the company keeps its books in; estimates beside foreign amounts are in it. */
  homeCurrency: KinCurrency.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(KIN_DEFAULT_HOME_CURRENCY)),
  ),
  rates: KinCurrencyRates.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /**
   * Where the company is. Stored before countries existed it is absent: a rupee company reads as
   * India, any other as unset. Unset has no tax line and a January year.
   */
  country: Schema.optional(Schema.NullOr(KinCountryCode)),
  financialYearStartMonth: Schema.optional(KinMonthNumber),
  /** Null charges no tax; India's GST is worked out by the invoice recipe instead. */
  tax: Schema.optional(Schema.NullOr(KinCompanyTax)),
  /**
   * False when an owner said the company is not registered for its country's tax: its documents
   * charge none and print no client's tax number. Absent or null when not said.
   */
  taxRegistered: Schema.optional(Schema.NullOr(Schema.Literal(false))),
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

/** Where "Download everything" streams the company's zip from; the link's token is the credential. */
export const KIN_EXPORT_ROUTE = "/api/kin/export";
/** What that zip holds and leaves out: Settings, the zip's README and the user guide say it in these words. */
export const KIN_EXPORT_HOLDS =
  "Your clients, contacts, projects, every list with its entries and their payments, each entry's comments, the contact logged with each client, each doc as it reads now, and the files entries, comments and docs hold, in one zip. Kin's import makes the clients, contacts, projects and entries again; the comments, logged contact, docs and files are there to keep.";
export const KIN_EXPORT_LEAVES =
  "It is not a full backup. Not in it: memory, which stays in your memory repository; chats; people and their access; agents and their characters; check-ins and reminders; connections, social accounts and their posts; budgets, bank statements and company details; settings; project repos and members; and who holds each entry, how it repeats and its history. Keys, tokens, sign-in sessions, pairing codes and bank details never leave.";
export const KinExportLinkInput = Schema.Struct({ orgId: KinOrgId });
export type KinExportLinkInput = typeof KinExportLinkInput.Type;
/** A relative link, good for minutes and for the session that asked for it. */
export const KinExportLink = Schema.Struct({
  url: Schema.String,
  fileName: Schema.String,
  expiresAt: Schema.String,
});
export type KinExportLink = typeof KinExportLink.Type;
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
  lutNumber: KinCompanyProfileFields.lutNumber,
  lutDate: KinCompanyProfileFields.lutDate,
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
  /** A client only clears the logo; a new one comes from a file the owner sent, by the agent's card. */
  logo: Schema.optional(Schema.Null),
  brand: Schema.optional(
    Schema.Struct({
      primaryColor: Schema.optional(KinCompanyBrand.fields.primaryColor),
      secondaryColor: Schema.optional(KinCompanyBrand.fields.secondaryColor),
      font: Schema.optional(KinCompanyBrand.fields.font),
      footer: Schema.optional(KinCompanyBrand.fields.footer),
    }),
  ),
  homeCurrency: Schema.optional(KinCurrency),
  /** Replaces every rate; send the list without one to remove it. */
  rates: Schema.optional(KinCurrencyRates),
  /** A new country also brings its currency, year and tax for any of those not sent with it. */
  country: Schema.optional(Schema.NullOr(KinCountryCode)),
  financialYearStartMonth: Schema.optional(KinMonthNumber),
  tax: Schema.optional(Schema.NullOr(KinCompanyTax)),
  /** False says the company is not registered for its tax, and clears its tax number; null unsays it. */
  taxRegistered: Schema.optional(Schema.NullOr(Schema.Literal(false))),
});
export type KinCompanyProfileSetInput = typeof KinCompanyProfileSetInput.Type;

const KIN_FINANCE_WS_METHODS = {
  lists: "kin.work.lists",
  updateList: "kin.work.updateList",
  dates: "kin.work.dates",
  money: "kin.work.money",
  recordPayment: "kin.work.recordPayment",
  voidPayment: "kin.work.voidPayment",
  files: "kin.work.files",
  companyProfile: "kin.work.companyProfile",
  setCompanyProfile: "kin.work.setCompanyProfile",
  issue: "kin.work.issue",
  nextNumber: "kin.work.nextNumber",
  void: "kin.work.void",
  unvoid: "kin.work.unvoid",
  receipts: "kin.work.receipts",
  makeReceipt: "kin.work.makeReceipt",
  exportLink: "kin.work.exportLink",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only, on the server; a chat-only session is refused before any handler runs.
export const KinFinanceRpcs = [
  Rpc.make(KIN_FINANCE_WS_METHODS.exportLink, {
    payload: KinExportLinkInput,
    success: KinExportLink,
    error,
  }),
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
  Rpc.make(KIN_FINANCE_WS_METHODS.files, {
    payload: KinWorkFilesInput,
    success: KinWorkFilesResult,
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
  Rpc.make(KIN_FINANCE_WS_METHODS.issue, {
    payload: KinIssueInput,
    success: KinIssueResult,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.nextNumber, {
    payload: KinIssueInput,
    success: KinNextNumberResult,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.void, { payload: KinVoidInput, success: KinIssueResult, error }),
  Rpc.make(KIN_FINANCE_WS_METHODS.unvoid, {
    payload: KinVoidInput,
    success: KinIssueResult,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.receipts, {
    payload: KinReceiptsInput,
    success: KinReceiptsResult,
    error,
  }),
  Rpc.make(KIN_FINANCE_WS_METHODS.makeReceipt, {
    payload: KinMakeReceiptInput,
    success: KinMakeReceiptResult,
    error,
  }),
] as const;

export const KIN_FINANCE_RPC_SCOPES = {
  [KIN_FINANCE_WS_METHODS.lists]: AuthKinChatScope,
  // What a list is, like what a lead is for, is an owner setting.
  [KIN_FINANCE_WS_METHODS.updateList]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.dates]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.money]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.recordPayment]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.voidPayment]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.files]: AuthKinChatScope,
  // Bank details: read and written only where owner settings are.
  [KIN_FINANCE_WS_METHODS.companyProfile]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.setCompanyProfile]: AuthKinChatScope,
  // A number is an entry change, like a payment; nothing leaves the host.
  [KIN_FINANCE_WS_METHODS.issue]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.nextNumber]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.void]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.unvoid]: AuthKinChatScope,
  [KIN_FINANCE_WS_METHODS.receipts]: AuthKinChatScope,
  // A receipt is an entry with a number, like issuing one.
  [KIN_FINANCE_WS_METHODS.makeReceipt]: AuthKinChatScope,
  // Everything the company keeps, to the owner alone; the zip comes over HTTP, not the socket.
  [KIN_FINANCE_WS_METHODS.exportLink]: AuthKinChatScope,
} as const;
