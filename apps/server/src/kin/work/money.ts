import { KinChatError, type KinMoney } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Exact money: integer minor units per ISO currency, parsed, summed and grouped in code with
 * BigInt arithmetic. Nothing here uses a float, and no total ever mixes two currencies.
 */

export const DEFAULT_CURRENCY = "INR";
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));
export const isCurrency = (code: string) => CURRENCIES.has(code);

/** Minor units per major one, as a power of ten: 2 for INR and USD, 0 for JPY, 3 for KWD. */
const currencyDigits = (currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;

const SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/₹|\brs\.?(?=\s|\d|$)|\brupees?\b/giu, "INR"],
  [/\$/gu, "USD"],
  [/€/gu, "EUR"],
  [/£/gu, "GBP"],
];
const MULTIPLIERS: ReadonlyArray<readonly [RegExp, bigint]> = [
  [/\b(?:crores?|cr)\b/giu, 10_000_000n],
  [/\b(?:lakhs?|lacs?|lakh)\b/giu, 100_000n],
  [/\b(?:millions?|mn)\b/giu, 1_000_000n],
  [/\b(?:thousand|k)\b|(?<=\d)k\b/giu, 1_000n],
];

/**
 * A spoken or written amount in minor units: "4.2 lakh", "₹1,23,456.78", "$12.5", "1.5 crore",
 * "12k". The currency is the one the text names, else `fallback`; naming another is refused.
 */
export const parseAmount = (
  text: string,
  fallback: string,
): { readonly money: KinMoney } | { readonly error: KinChatError } => {
  let rest = text.trim().replace(/\/-$/u, "");
  const named = new Set<string>();
  for (const [pattern, code] of SYMBOLS)
    rest = rest.replace(pattern, () => {
      named.add(code);
      return " ";
    });
  rest = rest.replace(/\b[A-Za-z]{3}\b/gu, (word) => {
    const code = word.toUpperCase();
    if (!isCurrency(code)) return word;
    named.add(code);
    return " ";
  });
  let multiplier = 1n;
  for (const [pattern, factor] of MULTIPLIERS)
    rest = rest.replace(pattern, () => {
      multiplier *= factor;
      return " ";
    });
  const number = rest.replace(/[\s,_]/gu, "");
  if (named.size > 1)
    return { error: invalid(`${text.slice(0, 40)} names two currencies. Give one amount.`) };
  const currency = named.values().next().value ?? fallback;
  if (!isCurrency(currency))
    return { error: invalid(`${currency.slice(0, 10)} is not a currency code such as INR.`) };
  const found = /^(\d{1,18})(?:\.(\d{1,18}))?$/u.exec(number);
  if (found === null)
    return {
      error: invalid(
        `${text.slice(0, 40)} is not an amount. Give a number such as 4200, 4.2 lakh or 1,23,456.78.`,
      ),
    };
  const fraction = found[2] ?? "";
  const digits = currencyDigits(currency);
  const scaled = BigInt(found[1]! + fraction) * multiplier * 10n ** BigInt(digits);
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n)
    return {
      error: invalid(
        `${text.slice(0, 40)} has more decimals than ${currency} has; round it to ${digits}.`,
      ),
    };
  const minor = scaled / divisor;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER))
    return { error: invalid(`${text.slice(0, 40)} is too large an amount.`) };
  return { money: { minor: Number(minor), currency } };
};

/** For people and models: Indian digit grouping for INR, `₹4,20,000.00`. */
export const formatMoney = (money: KinMoney) => {
  const digits = currencyDigits(money.currency);
  const minor = BigInt(money.minor);
  const unit = 10n ** BigInt(digits);
  const whole = new Intl.NumberFormat(money.currency === "INR" ? "en-IN" : "en", {
    style: "currency",
    currency: money.currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(minor / unit);
  return digits === 0 ? whole : `${whole}.${(minor % unit).toString().padStart(digits, "0")}`;
};

/** One exact total per currency: INR first, then by code. Refuses a total past a safe integer. */
export const addUp = (amounts: Iterable<KinMoney>): ReadonlyArray<KinMoney> => {
  const sums = new Map<string, bigint>();
  for (const amount of amounts)
    sums.set(amount.currency, (sums.get(amount.currency) ?? 0n) + BigInt(amount.minor));
  return [...sums]
    .toSorted(([a], [b]) =>
      a === b ? 0 : a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a < b ? -1 : 1,
    )
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
