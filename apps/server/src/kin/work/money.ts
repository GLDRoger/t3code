import {
  formatKinMoney,
  isKinCurrency,
  KinChatError,
  kinCurrency,
  type KinMoney,
  parseKinMoney,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Exact money: integer minor units per ISO currency, parsed, summed and grouped in code with
 * BigInt arithmetic. Nothing here uses a float, and no total ever mixes two currencies.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

export const isCurrency = isKinCurrency;

/** Minor units per major one, as a power of ten: 2 for INR and USD, 0 for JPY, 3 for KWD. */
export const currencyDigits = (currency: string) => kinCurrency(currency).decimals;

/** A spoken or written amount in minor units, in the currency it names else `fallback`. */
export const parseAmount = (
  text: string,
  fallback: string,
): { readonly money: KinMoney } | { readonly error: KinChatError } => {
  const read = parseKinMoney(text, fallback);
  return "money" in read ? read : { error: invalid(read.error) };
};

/** For people and models: `₹4,20,000.00`, every minor digit. */
export const formatMoney = (money: KinMoney) => formatMinor(BigInt(money.minor), money.currency);

/** Exact minor units of any size, `-₹1,200.50` below zero; never through a float. */
export const formatMinor = (minor: bigint, currency: string) =>
  formatKinMoney(minor, currency, { cents: "always" });

/** `minor` rounded to a whole major unit: rupees, dollars, yen. */
export const roundToWhole = (minor: number, currency: string) => {
  const unit = 10 ** currencyDigits(currency);
  return Math.round(minor / unit) * unit;
};

/** A line people read: `₹4,20,000`, with paise only when there are some. */
export const formatMoneyPlain = (money: KinMoney) => formatKinMoney(money.minor, money.currency);

/**
 * One exact total per currency: the home currency first, then by code. Refuses a total past a
 * safe integer.
 */
export const addUp = (amounts: Iterable<KinMoney>, home: string): ReadonlyArray<KinMoney> => {
  const sums = new Map<string, bigint>();
  for (const amount of amounts)
    sums.set(amount.currency, (sums.get(amount.currency) ?? 0n) + BigInt(amount.minor));
  return [...sums]
    .toSorted(([a], [b]) => (a === b ? 0 : a === home ? -1 : b === home ? 1 : a < b ? -1 : 1))
    .map(([currency, minor]) => {
      if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < 0n)
        throw new RangeError(`A ${currency} total is out of range`);
      return { minor: Number(minor), currency };
    });
};

/** The calendar day an instant falls on in `zone`. */
export const dayIn = (ms: number, zone: string) =>
  DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone: zone }));
/** `2026-11` from a day. */
export const monthOf = (day: string) => day.slice(0, 7);
/** India's financial year, April to March: 2026-04-01 to 2027-03-31 is `FY2026-27`. */
export const financialYearOf = (day: string) => {
  const year = Number.parseInt(day.slice(0, 4), 10);
  const start = Number.parseInt(day.slice(5, 7), 10) >= 4 ? year : year - 1;
  return `FY${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};
/** The month `count` months after `month` (`2026-11`), negative for earlier. */
export const shiftMonth = (month: string, count: number) => {
  const index =
    Number.parseInt(month.slice(0, 4), 10) * 12 + Number.parseInt(month.slice(5, 7), 10) - 1;
  const next = index + count;
  return `${Math.floor(next / 12)}-${String((next % 12) + 1).padStart(2, "0")}`;
};
