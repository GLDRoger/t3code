// @effect-diagnostics globalDate:off - Pure view helpers format a rate's day for React render, outside an Effect runtime.
import { kinCurrency, kinWhenFormat } from "@t3tools/contracts";
import type {
  KinRecordDetail,
  KinRecordKey,
  KinCompanyProfile,
  KinCompanyProfileSetInput,
  KinCurrencyRate,
  KinMoney,
  KinMoneyAbout,
  KinMoneySummary,
  KinMoneyTotals,
  KinOrgId,
} from "@t3tools/contracts";

import { kinMinorDigits, kinMoneyText } from "./kinLists.ts";

/**
 * Money in more than one currency. Every exact figure stays in its own currency; beside a foreign
 * one goes "about ₹x" at a rate the owner set or a bank row showed. An estimate is never added
 * into an exact figure, an invoice, a receipt or an export.
 */

/** "rupees" for INR, a currency's code where it has no name of its own. */
const homeUnits = (home: string) => {
  const major = kinCurrency(home).major;
  return major === home ? home : major.toLowerCase();
};

export const KIN_CURRENCY = {
  ratesFailed: "Couldn't load the rates",
  exactStays: "Exact figures, invoices and exports stay in their own currency.",
  paidUnlinked: (currency: string, home: string) =>
    `Paid in ${currency}. No bank row is linked yet, so the ${homeUnits(home)} received aren't known.`,
  noRates: "No rates yet, so no foreign amount shows an estimate.",
  rateForEstimates: "Use this rate for estimates",
  setRate: "Set a rate",
  rates: "Exchange rates",
  ratesDetail:
    "Used only for the “about” figures beside foreign amounts. Invoices, receipts and exports always keep their own currency.",
  rate: "Rate",
  asOf: "As of",
  save: "Save rate",
  remove: "Remove rate",
  homeCurrency: "Home currency",
  estimate: "Estimate",
  noRate: (currency: string) => `No ${currency} rate set, so no estimate.`,
  badRate: "Enter a rate above zero, like 84.25.",
  badDay: "Enter a day as YYYY-MM-DD.",
  sameAsHome: (currency: string) => `${currency} is the home currency already.`,
  /** "About $1,540 owed at your rates; AED not included". */
  aboutOwed: (amount: string, missing: ReadonlyArray<string>) =>
    `About ${amount} owed at your rates${missing.length === 0 ? "" : `; ${kinAnd(missing)} not included`}`,
};

const kinAnd = (parts: ReadonlyArray<string>) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The rates the owner set and the currency estimates are in. Absent until the profile loads. */
export interface KinRates {
  readonly home: string;
  readonly rates: ReadonlyArray<KinCurrencyRate>;
}

export const kinRatesOf = (
  profile: Pick<KinCompanyProfile, "homeCurrency" | "rates">,
): KinRates => ({
  home: profile.homeCurrency,
  rates: profile.rates,
});

const RATE = /^(\d{1,7})(?:\.(\d{1,6}))?$/;
const MICROS = 1_000_000n;

/** A rate as millionths of a home unit per foreign unit; null unless it is a rate above zero. */
export function kinRateMicros(text: string): bigint | null {
  const found = RATE.exec(text.trim().replace(/,/g, ""));
  if (found === null) return null;
  const micros = BigInt(found[1]!) * MICROS + BigInt((found[2] ?? "").padEnd(6, "0"));
  return micros > 0n ? micros : null;
}

const kinRateFor = (rates: KinRates, currency: string): KinCurrencyRate | null =>
  rates.rates.find((one) => one.currency === currency) ?? null;

/** `money` in the home currency at `rate`, rounded to the nearest minor unit. */
export function kinConvert(money: KinMoney, rate: string, home: string): KinMoney | null {
  const micros = kinRateMicros(rate);
  if (micros === null) return null;
  const scale = kinMinorDigits(home) - kinMinorDigits(money.currency);
  let numerator = BigInt(money.minor) * micros;
  let denominator = MICROS;
  if (scale >= 0) numerator *= 10n ** BigInt(scale);
  else denominator *= 10n ** BigInt(-scale);
  const minor = (numerator * 2n + denominator) / (denominator * 2n);
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? null : { minor: Number(minor), currency: home };
}

export interface KinEstimate {
  /** "about ₹5,05,500". */
  readonly text: string;
  /** "At ₹84.25 per $1, as of 10 Nov 2026." */
  readonly basis: string;
  readonly money: KinMoney;
}

const dayFormat = kinWhenFormat("dateYear", { zone: "UTC" });
/** "Nov 10, 2026" for a rate's `YYYY-MM-DD` day. */
export const kinRateDay = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

/** "₹84.25 per $1, as of 10 Nov 2026". */
export function kinRateLine(rate: KinCurrencyRate, home: string): string {
  const unit = kinMoneyText({
    minor: 10 ** kinMinorDigits(rate.currency),
    currency: rate.currency,
  });
  const value = rate.rate.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${kinMoneyText({ minor: 0, currency: home }).replace(/[\d.,\s]+$/, "")}${value} per ${unit}, as of ${kinRateDay(rate.asOf)}`;
}

/** "about ₹x" beside a foreign amount; null in the home currency or with no rate for it. */
export function kinEstimate(money: KinMoney, rates: KinRates | null): KinEstimate | null {
  if (rates === null || money.currency === rates.home) return null;
  const rate = kinRateFor(rates, money.currency);
  if (rate === null) return null;
  const exact = kinConvert(money, rate.rate, rates.home);
  if (exact === null) return null;
  // An estimate never shows paise: it is about, not to the paisa.
  const unit = 10 ** kinMinorDigits(rates.home);
  const converted = { ...exact, minor: Math.round(exact.minor / unit) * unit };
  return {
    text: `about ${kinMoneyText(converted)}`,
    basis: `At ${kinRateLine(rate, rates.home)}.`,
    money: converted,
  };
}

/** Each foreign amount's estimate, by its exact text as a figure shows it. */
export function kinEstimatesByLine(
  amounts: ReadonlyArray<KinMoney>,
  rates: KinRates | null,
): ReadonlyMap<string, KinEstimate> {
  const held = new Map<string, KinEstimate>();
  for (const money of amounts) {
    const estimate = kinEstimate(money, rates);
    if (estimate !== null) held.set(kinMoneyText(money), estimate);
  }
  return held;
}

export interface KinTotalsEstimate {
  /** "about ₹14,60,000 in all": every currency counted, so the line is only there when it can be. */
  readonly all: string | null;
  /** Foreign currencies with no rate, which "Set a rate" offers. */
  readonly missing: ReadonlyArray<string>;
  readonly basis: ReadonlyArray<string>;
}

/** One combined estimate for totals in more than one currency; never an exact figure. */
export function kinTotalsEstimate(
  totals: KinMoneyTotals,
  rates: KinRates | null,
): KinTotalsEstimate | null {
  if (rates === null) return null;
  const foreign = totals.filter((money) => money.currency !== rates.home);
  if (foreign.length === 0) return null;
  const missing = foreign.filter((money) => kinRateFor(rates, money.currency) === null);
  const basis = foreign.flatMap((money) => {
    const rate = kinRateFor(rates, money.currency);
    return rate === null ? [] : [kinRateLine(rate, rates.home)];
  });
  if (missing.length > 0)
    return { all: null, missing: missing.map((money) => money.currency), basis };
  let minor = 0;
  for (const money of totals) {
    const converted = money.currency === rates.home ? money : kinEstimate(money, rates)?.money;
    if (converted === undefined) return { all: null, missing: [], basis };
    minor += converted.minor;
  }
  return {
    all: `about ${kinMoneyText({ minor, currency: rates.home })} in all`,
    missing: [],
    basis,
  };
}

/**
 * The one line beside what is owed: the host's estimate at the owner's rates, naming what it
 * leaves out. An older host sends none; then it is this client's, only with every rate set.
 */
export function kinOwedAbout(
  summary: {
    readonly owed: Pick<KinMoneySummary["owed"], "total">;
    readonly about?: KinMoneySummary["about"];
  },
  rates: KinRates | null,
): { readonly text: string; readonly basis: ReadonlyArray<string> } | null {
  if (summary.about === undefined) {
    const all = kinTotalsEstimate(summary.owed.total, rates);
    return all?.all == null
      ? null
      : { text: `${all.all} owed (estimate)`, basis: all.basis.map((line) => `At ${line}.`) };
  }
  const about: KinMoneyAbout | undefined = summary.about.owed;
  if (about === undefined) return null;
  const basis = summary.owed.total.flatMap((money) => {
    const rate =
      rates === null || money.currency === about.home || about.missing.includes(money.currency)
        ? null
        : kinRateFor(rates, money.currency);
    return rate === null ? [] : [`At ${kinRateLine(rate, about.home)}.`];
  });
  return { text: KIN_CURRENCY.aboutOwed(kinMoneyText(about.total), about.missing), basis };
}

/** The foreign currencies among `totals` that have no rate yet. */
export const kinMissingRates = (totals: KinMoneyTotals, rates: KinRates | null) =>
  rates === null
    ? []
    : [
        ...new Set(
          totals
            .filter(
              (money) =>
                money.currency !== rates.home && kinRateFor(rates, money.currency) === null,
            )
            .map((money) => money.currency),
        ),
      ];

export interface KinRateDraft {
  readonly currency: string;
  readonly rate: string;
  readonly asOf: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The profile change that sets (or, with `remove`, drops) one rate; a problem to show instead. */
export function kinRateInput(
  orgId: KinOrgId,
  profile: Pick<KinCompanyProfile, "rev" | "homeCurrency" | "rates">,
  draft: KinRateDraft,
  remove = false,
): { readonly input: KinCompanyProfileSetInput } | { readonly problem: string } {
  const currency = draft.currency.trim().toUpperCase();
  const others = profile.rates.filter((one) => one.currency !== currency);
  if (remove) return { input: { orgId, rev: profile.rev, rates: others } };
  if (currency === profile.homeCurrency) return { problem: KIN_CURRENCY.sameAsHome(currency) };
  if (kinRateMicros(draft.rate) === null) return { problem: KIN_CURRENCY.badRate };
  if (!DAY.test(draft.asOf.trim())) return { problem: KIN_CURRENCY.badDay };
  const rate = draft.rate.trim().replace(/,/g, "");
  return {
    input: {
      orgId,
      rev: profile.rev,
      rates: [...others, { currency, rate, asOf: draft.asOf.trim() }].sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
    },
  };
}

/**
 * What a foreign invoice actually brought in, from the bank row that settled it: the rupees, the
 * rate they imply, and how far they are from the estimate at the owner's rate.
 */
export interface KinSettledView {
  readonly received: string;
  readonly implied: string;
  readonly difference: string | null;
  readonly impliedRate: KinRateDraft;
}

export function kinSettled(
  invoice: KinMoney,
  bank: KinMoney,
  bankDay: string,
  rates: KinRates | null,
): KinSettledView | null {
  if (invoice.currency === bank.currency || invoice.minor === 0) return null;
  // Home units per foreign unit, to six places: bank minor over invoice minor, rescaled.
  const scale = kinMinorDigits(invoice.currency) - kinMinorDigits(bank.currency);
  let numerator = BigInt(bank.minor) * MICROS;
  let denominator = BigInt(invoice.minor);
  if (scale >= 0) numerator *= 10n ** BigInt(scale);
  else denominator *= 10n ** BigInt(-scale);
  const micros = (numerator * 2n + denominator) / (denominator * 2n);
  const rate = `${micros / MICROS}.${String(micros % MICROS).padStart(6, "0")}`.replace(
    /\.?0+$/,
    "",
  );
  const impliedRate = { currency: invoice.currency, rate, asOf: bankDay };
  const estimate = rates === null ? null : kinEstimate(invoice, rates);
  const gap = estimate === null ? null : bank.minor - estimate.money.minor;
  return {
    received: kinMoneyText(bank),
    implied: kinRateLine(impliedRate, bank.currency),
    difference:
      gap === null || estimate === null
        ? null
        : gap === 0
          ? `The same as the estimate at your rate.`
          : `${kinMoneyText({ minor: Math.abs(gap), currency: bank.currency })} ${gap > 0 ? "more" : "less"} than the estimate at your rate (${estimate.text.replace(/^about /, "")}).`,
    impliedRate,
  };
}

/** "US Dollar (USD)", or the code alone where this device can't name it. */
function kinCurrencyName(currency: string): string {
  try {
    const name = new Intl.DisplayNames(undefined, { type: "currency" }).of(currency);
    return name === undefined || name === currency ? currency : `${name} (${currency})`;
  } catch {
    return currency;
  }
}

/** How a foreign-currency invoice says what currency it is in, and what it is about worth. */
export interface KinInvoiceCurrencyView {
  readonly currency: string;
  /** The company's home currency, the one an estimate is in. */
  readonly home: string;
  /** "Amounts in US Dollar (USD)". */
  readonly label: string;
  readonly estimate: KinEstimate | null;
  readonly missingRate: boolean;
  /** The bank row that settled it, when a statement or an agent linked one. */
  readonly bank: KinRecordKey | null;
}

export function kinInvoiceCurrency(
  item: Pick<KinRecordDetail, "amount" | "links">,
  rates: KinRates | null,
): KinInvoiceCurrencyView | null {
  const amount = item.amount;
  if (amount === undefined || rates === null || amount.currency === rates.home) return null;
  const bank =
    item.links.find(
      (link) => link.kind === "record" && link.relation === "evidence" && link.record !== undefined,
    )?.record?.key ?? null;
  const estimate = kinEstimate(amount, rates);
  return {
    currency: amount.currency,
    home: rates.home,
    label: `Amounts in ${kinCurrencyName(amount.currency)}`,
    estimate,
    missingRate: estimate === null,
    bank: bank as KinRecordKey | null,
  };
}
