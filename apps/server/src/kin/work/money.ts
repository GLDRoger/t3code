import {
  formatKinMoney,
  isKinCurrency,
  KinChatError,
  kinCurrency,
  type KinCurrencyRate,
  type KinMoney,
  type KinMoneyAbout,
  type KinOrgId,
  formatKinWhen,
  KIN_TEXT_LOCALE,
  parseKinMoney,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { homeCurrency } from "./companyProfile.ts";
import { countedEntry } from "./recordRows.ts";

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
  if (!("money" in read)) return { error: invalid(read.error) };
  return read.money.minor < 0
    ? { error: invalid(`${text.slice(0, 40)} is below zero; Kin records an amount of 0 or more.`) }
    : read;
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
 * One exact total per currency, a refund taking its part off: the home currency first, then by
 * code. Refuses a total past a safe integer either side of zero.
 */
export const addUp = (amounts: Iterable<KinMoney>, home: string): ReadonlyArray<KinMoney> => {
  const sums = new Map<string, bigint>();
  for (const amount of amounts)
    sums.set(amount.currency, (sums.get(amount.currency) ?? 0n) + BigInt(amount.minor));
  return [...sums]
    .toSorted(([a], [b]) => (a === b ? 0 : a === home ? -1 : b === home ? 1 : a < b ? -1 : 1))
    .map(([currency, minor]) => {
      if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER))
        throw new RangeError(`A ${currency} total is out of range`);
      return { minor: Number(minor), currency };
    });
};

const RATE = /^(\d+)(?:\.(\d{1,6}))?$/u;

/**
 * Totals in several currencies as one estimate in `home` at the owner's `rates`, summed exactly
 * and rounded once to a whole unit; currencies with no rate are named in `missing`. Undefined for
 * one currency, or when no currency could be counted. Never fetches or invents a rate. An amount
 * with `charged`, what its bank line took in `home` on its day, counts at that instead.
 */
export const aboutTotal = (
  totals: ReadonlyArray<KinMoney & { readonly charged?: KinMoney }>,
  home: string,
  rates: ReadonlyArray<KinCurrencyRate>,
): KinMoneyAbout | undefined => {
  if (new Set(totals.map((one) => one.currency)).size < 2) return undefined;
  const homeDigits = currencyDigits(home);
  // Billionths of a home minor unit: a six-place rate on a 3-decimal currency stays whole.
  const scale = 10n ** 9n;
  let sum = 0n;
  let counted = 0;
  const missing: Array<string> = [];
  for (const one of totals) {
    const money = one.charged?.currency === home ? one.charged : one;
    if (money.currency === home) {
      sum += BigInt(money.minor) * scale;
      counted += 1;
      continue;
    }
    const found = RATE.exec(rates.find((one) => one.currency === money.currency)?.rate ?? "");
    const micros =
      found === null
        ? 0n
        : BigInt(found[1]!) * 1_000_000n + BigInt((found[2] ?? "").padEnd(6, "0"));
    if (micros === 0n) {
      missing.push(money.currency);
      continue;
    }
    const shift = homeDigits - currencyDigits(money.currency) + 3;
    sum += BigInt(money.minor) * micros * 10n ** BigInt(shift);
    counted += 1;
  }
  if (counted === 0) return undefined;
  const unit = scale * 10n ** BigInt(homeDigits);
  const size = sum < 0n ? -sum : sum;
  const whole = (size * 2n + unit) / (unit * 2n);
  const minor = (sum < 0n ? -whole : whole) * 10n ** BigInt(homeDigits);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER))
    return undefined;
  return { home, total: { minor: Number(minor), currency: home }, missing };
};

/** The calendar day an instant falls on in `zone`. */
export const dayIn = (ms: number, zone: string) =>
  DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone: zone }));
/** An instant as `zone`'s own clock reads it, with its offset: `2026-12-05T00:16:00.000+14:00`. */
export const timeIn = (ms: number, zone: string) =>
  DateTime.formatIsoOffset(DateTime.makeZonedUnsafe(ms, { timeZone: zone }));
/** `Mon 23 Nov 2026`: the day an instant falls on in `zone`, beside a due's machine value. */
export const dayWords = (ms: number, zone: string) =>
  formatKinWhen(ms, "dayYear", { zone, locale: KIN_TEXT_LOCALE }).replace(/,/g, "");
/** `2026-11` from a day. */
export const monthOf = (day: string) => day.slice(0, 7);
/**
 * The financial year a day falls in, the year starting in `startMonth`: from April, 2026-04-01 to
 * 2027-03-31 is `FY2026-27`; from January, 2026 is `FY2026`. Every caller passes its company's.
 */
export const financialYearOf = (day: string, startMonth = 4) => {
  const year = Number.parseInt(day.slice(0, 4), 10);
  const start = Number.parseInt(day.slice(5, 7), 10) >= startMonth ? year : year - 1;
  return startMonth === 1
    ? `FY${start}`
    : `FY${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};
/** The first day of the financial year `financialYearOf` named. */
export const financialYearStart = (year: string, startMonth: number) =>
  `${year.slice(2, 6)}-${String(startMonth).padStart(2, "0")}-01`;
/** The month `count` months after `month` (`2026-11`), negative for earlier. */
export const shiftMonth = (month: string, count: number) => {
  const index =
    Number.parseInt(month.slice(0, 4), 10) * 12 + Number.parseInt(month.slice(5, 7), 10) - 1;
  const next = index + count;
  return `${Math.floor(next / 12)}-${String((next % 12) + 1).padStart(2, "0")}`;
};

const CHECK_IT = "Check it, or pass confirmed true if it is right.";
const EMPTY_LIST_MAJOR = 10_000_000n;

/** The largest counted amount of a list in one currency, but for `except`; 0 when none. */
export const largestIn = Effect.fn("KinMoney.largestIn")(function* (
  orgId: KinOrgId,
  list: string,
  currency: string,
  except?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ largest: number | null }>`SELECT MAX(ABS(r.amount_minor)) AS largest
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = ${list}
      AND r.currency = ${currency} AND r.amount_minor IS NOT NULL AND ${countedEntry(sql)}
      AND r.record_id <> ${except ?? ""}`;
  return BigInt(row?.largest ?? 0);
});

/**
 * Why an amount an agent or an import is about to save reads like a slip: over a thousand times
 * the largest counted entry of its list in its currency, or with none there, over 10 million in
 * the home currency. A person's form asks the same once (`askSlip`).
 */
export const farAbove = (
  listName: string,
  money: KinMoney,
  largest: bigint,
  home: string,
): string | undefined => {
  const size = BigInt(Math.abs(money.minor));
  if (largest > 0n)
    return size > largest * 1_000n
      ? `${formatMoney(money)} is far above anything in ${listName} (largest ${formatMinor(largest, money.currency)}). ${CHECK_IT}`
      : undefined;
  return money.currency === home && size > EMPTY_LIST_MAJOR * 10n ** BigInt(currencyDigits(home))
    ? `${formatMoney(money)} is far above what ${listName} holds so far. ${CHECK_IT}`
    : undefined;
};

/**
 * A person's form's amount `farAbove` flags, refused with the list's name and its largest entry
 * (null when it holds none) for the form to ask; saved again with `amountConfirmed`, it stands.
 */
export const askSlip = Effect.fn("KinMoney.askSlip")(function* (
  orgId: KinOrgId,
  def: { readonly id: string; readonly name: string },
  money: KinMoney,
  except?: string,
) {
  const largest = yield* largestIn(orgId, def.id, money.currency, except);
  if (farAbove(def.name, money, largest, yield* homeCurrency(orgId)) === undefined) return;
  return yield* new KinChatError({
    reason: "invalid_state",
    message:
      largest > 0n
        ? `${formatMoneyPlain(money)} is far above anything in ${def.name} so far (the largest is ${formatKinMoney(largest, money.currency)}). Check the amount.`
        : `${formatMoneyPlain(money)} is far above what ${def.name} holds so far. Check the amount.`,
    farAbove: {
      list: def.name,
      largest: largest > 0n ? { minor: Number(largest), currency: money.currency } : null,
    },
  });
});

/** What typed lines come to before tax, each quantity times rate rounded half up; none if unread. */
export const linesBeforeTax = (
  lines: ReadonlyArray<{ readonly quantity: string; readonly rate: string }>,
  currency: string,
): KinMoney | undefined => {
  let total = 0n;
  for (const line of lines) {
    const rate = parseAmount(line.rate, currency);
    const quantity = /^(\d{1,9})(?:\.(\d{1,3}))?$/u.exec(line.quantity);
    if ("error" in rate || rate.money.currency !== currency || quantity === null) return undefined;
    const places = quantity[2] ?? "";
    const den = 10n ** BigInt(places.length);
    const product = BigInt(rate.money.minor) * BigInt(`${quantity[1]}${places}`);
    total += product / den + (2n * (product % den) >= den ? 1n : 0n);
  }
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : { minor: Number(total), currency };
};

/** An invoice dated after its own due day, as days in the owner's zone. */
export const issuedAfterDue = (dateAt: number | null, dueAt: number | null, zone: string) => {
  if (dateAt === null || dueAt === null) return undefined;
  const [issued, due] = [dayIn(dateAt, zone), dayIn(dueAt, zone)];
  return issued > due
    ? `An invoice issued ${issued} can't fall due ${due}, before it. Check the dates, or pass confirmed true if they are right.`
    : undefined;
};
