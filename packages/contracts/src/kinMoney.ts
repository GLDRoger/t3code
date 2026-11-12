import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatId, KinMessageId, KinTrimmedText } from "./kinChat.ts";

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
/** One figure per currency, INR first, then by code; an empty list is nothing. */
export const KinMoneyTotals = Schema.Array(KinMoney);
export type KinMoneyTotals = typeof KinMoneyTotals.Type;

/** A built-in list (`work`, `clients`, `expenses`) or one defined in chat. */
export const KinListId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{1,39}$/));
export type KinListId = typeof KinListId.Type;
/** A calendar day in the owner's time zone. */
export const KinDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
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
export const KinPayment = Schema.Struct({
  paymentId: TrimmedNonEmptyString,
  amount: KinMoney,
  paidOn: KinDay,
  note: Schema.String,
  recordedAt: IsoDateTime,
  voidedAt: Schema.NullOr(IsoDateTime),
  /** Absent from older servers; `null` when it has no receipt yet (make one with makeReceipt). */
  receipt: Schema.optionalKey(Schema.NullOr(KinPaymentReceipt)),
});
export type KinPayment = typeof KinPayment.Type;
