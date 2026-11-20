import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinChatId, KinMessageId, KinPersonId, KinTrimmedText } from "./kinChat.ts";

/**
 * Money and the typed pieces of a list entry. Amounts are integer minor units (paise for INR)
 * with an ISO 4217 code: never floats, never summed across currencies, never by a model.
 */

export const KinCurrency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/));
export type KinCurrency = typeof KinCurrency.Type;
/** Every amount and every total. `minor` is a safe integer: 4.2 lakh rupees is 42000000. */
export const KinMoney = Schema.Struct({
  minor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  currency: KinCurrency,
});
export type KinMoney = typeof KinMoney.Type;
/** A balance, a net, a refund or a total refunds lowered: below zero is owed, overdrawn or back. */
export const KinSignedMoney = Schema.Struct({
  minor: Schema.Int.check(
    Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  currency: KinCurrency,
});
export type KinSignedMoney = typeof KinSignedMoney.Type;
/** One figure per currency, home first, then by code; an empty list is nothing. */
export const KinMoneyTotals = Schema.Array(KinSignedMoney);
export type KinMoneyTotals = typeof KinMoneyTotals.Type;
/**
 * Totals in more than one currency as one figure in `home`, at the rates the owner set: an
 * estimate, never an exact figure. `missing` has no rate and is left out of `total`.
 */
export const KinMoneyAbout = Schema.Struct({
  home: KinCurrency,
  total: KinSignedMoney,
  missing: Schema.Array(KinCurrency),
});
export type KinMoneyAbout = typeof KinMoneyAbout.Type;

/** A built-in list (`work`, `clients`, `expenses`) or one defined in chat. */
export const KinListId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{1,39}$/));
export type KinListId = typeof KinListId.Type;
/** A real calendar day as YYYY-MM-DD from year 1000: `Date.parse` takes 30 February as 2 March. */
export const isCalendarDay = (value: string) => {
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
};
/** An ISO day or time as epoch ms, NaN unless it parses and its day is real. */
export const calendarTimeMillis = (value: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(value) && !isCalendarDay(value.slice(0, 10))
    ? Number.NaN
    : Date.parse(value);
/** A calendar day in the owner's time zone. */
export const KinDay = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(isCalendarDay, { expected: "a real YYYY-MM-DD calendar date" }),
);
export type KinDay = typeof KinDay.Type;

/**
 * When a repeating entry closes, Kin creates the next one, once: a month, a quarter or a year
 * after its date (the same day of the month, or the month's last), or every `days` days.
 */
export const KinRepeatRule = Schema.Union([
  Schema.Struct({ every: Schema.Literals(["month", "quarter", "year"]) }),
  Schema.Struct({
    every: Schema.Literal("days"),
    days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 366 })),
  }),
]);
export type KinRepeatRule = typeof KinRepeatRule.Type;

/** A file kept on an entry: one already sent in chat, readable by whoever may read that chat. */
export const KinFileRef = Schema.Struct({
  attachmentId: TrimmedNonEmptyString,
  name: KinTrimmedText,
  mimeType: Schema.String,
  chatId: KinChatId,
  messageId: KinMessageId,
});
export type KinFileRef = typeof KinFileRef.Type;

/** A field of a defined list, by the key its definition gives it. */
export const KinListFieldKey = Schema.String.check(Schema.isPattern(/^[a-z][a-zA-Z0-9]{0,39}$/));
export type KinListFieldKey = typeof KinListFieldKey.Type;

/** A list field's stored value: text, a choice or a day; files and people as ids; money. */
export const KinFieldValue = Schema.Union([Schema.String, Schema.Array(Schema.String), KinMoney]);
export type KinFieldValue = typeof KinFieldValue.Type;

/** Money paid against an entry that is paid over time. A voided one stays in the history and counts for nothing. */
/**
 * The receipt for a payment: Kin's receipt entry, or only the number another system gave it,
 * kept in the payment's note, until a receipt is made for it (`key` and `document` then null).
 */
export const KinPaymentReceipt = Schema.Struct({
  key: Schema.NullOr(TrimmedNonEmptyString),
  number: Schema.NullOr(TrimmedNonEmptyString),
  receivedOn: KinDay,
  amount: KinMoney,
  /** The receipt's PDF, a doc. */
  document: Schema.NullOr(TrimmedNonEmptyString),
});
export type KinPaymentReceipt = typeof KinPaymentReceipt.Type;
/**
 * Where a payment came from: a line of a bank statement the owner confirmed; a person's word, by
 * their own tap or by an agent acting on their message (`agentId`); an agent with no one's word
 * behind its turn; or `recorded`, written here some other way (an import, Kin itself).
 */
export const KinPaymentSource = Schema.Union([
  Schema.TaggedStruct("statement", {}),
  Schema.TaggedStruct("person", {
    personId: KinPersonId,
    agentId: Schema.optionalKey(KinAgentId),
    /** Their Yes on Kin's card for a bank alert; absent from older hosts. */
    bankAlert: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("agent", { agentId: KinAgentId }),
  Schema.TaggedStruct("recorded", {}),
]);
export type KinPaymentSource = typeof KinPaymentSource.Type;
/**
 * How far Kin sees the bank: the last day of the unbroken run of bank statements the owner
 * confirmed, or null when none is confirmed. Kin can't tell what reached the bank after it.
 */
export const KinBankKnown = Schema.Struct({
  through: Schema.NullOr(KinDay),
  /**
   * Per account, what the owner's bank alerts add after `through`: never complete, so they never
   * move it. Absent from older hosts and where no alert counts.
   */
  alerts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        account: Schema.String.check(Schema.isMaxLength(200)),
        currency: Schema.String.check(Schema.isMaxLength(8)),
        /** The statements' day the alerts count after; null with no statement for it. */
        since: Schema.NullOr(KinDay),
        seenThrough: KinDay,
        in: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        out: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        /** The newest alert's stated balance, or an estimate from the last closing balance. */
        balance: Schema.optional(
          Schema.Struct({ minor: Schema.Int, on: KinDay, estimate: Schema.Boolean }),
        ),
        /** The company has more than one account in statements or alerts: name this one. */
        named: Schema.optional(Schema.Literal(true)),
      }),
    ).check(Schema.isMaxLength(50)),
  ),
  /** Mailboxes whose bank alerts stopped counting when they were disconnected, and the day. */
  alertsStopped: Schema.optional(
    Schema.Array(
      Schema.Struct({ mailbox: Schema.String.check(Schema.isMaxLength(320)), on: KinDay }),
    ).check(Schema.isMaxLength(20)),
  ),
});
export type KinBankKnown = typeof KinBankKnown.Type;
export const KinPayment = Schema.Struct({
  paymentId: TrimmedNonEmptyString,
  amount: KinMoney,
  paidOn: KinDay,
  note: Schema.String,
  recordedAt: IsoDateTime,
  voidedAt: Schema.NullOr(IsoDateTime),
  /** Tax the client deducted at source (TDS), recorded so the invoice settles; not money in. */
  withheld: Schema.optionalKey(Schema.Literal(true)),
  /** Absent from older servers; `null` when it has no receipt yet (make one with makeReceipt). */
  receipt: Schema.optionalKey(Schema.NullOr(KinPaymentReceipt)),
  /** Absent from older servers. */
  source: Schema.optionalKey(KinPaymentSource),
});
export type KinPayment = typeof KinPayment.Type;
