import type { KinMoney } from "./kinMoney.ts";

/**
 * Kin's one description of each currency, and the one way an amount is written and read back.
 * The server, generated documents, agents' text and both clients all go through here; adding a
 * currency is one row. Stored `minor` amounts use `decimals`, which follow CLDR as Node's Intl
 * reports them (`kinCurrency.test.ts` holds the two together), so nothing already stored moves.
 */

export interface KinCurrencyInfo {
  readonly code: string;
  /** Minor units per major one, as a power of ten: 2 for USD, 0 for JPY and PKR, 3 for KWD. */
  readonly decimals: number;
  /** What precedes an amount: "$", "₹", or the code and a no-break space ("PKR 1,500"). */
  readonly symbol: string;
  /** "indian" groups lakh and crore (12,34,567); "western" groups thousands. */
  readonly grouping: "indian" | "western";
  /** The major and minor unit as a document writes them in words. */
  readonly major: string;
  readonly minor: string;
}

const ZERO_DECIMALS =
  "AFN ALL BIF CLP COP DJF GNF HUF IDR IQD IRR ISK JPY KMF KPW KRW LAK LBP MGA MMK PKR PYG RWF SLL SOS SYP UGX VND VUV XAF XOF XPF YER";
const THREE_DECIMALS = "BHD JOD KWD LYD OMR TND";
const CODES = `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN
BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL
GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF
KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR
MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG
SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD
UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL`;

/** Where a currency differs from "its code, two decimals, thousands, no unit words". */
const ROWS: Readonly<Record<string, Partial<Omit<KinCurrencyInfo, "code" | "decimals">>>> = {
  INR: { symbol: "₹", grouping: "indian", major: "Rupees", minor: "Paise" },
  USD: { symbol: "$", major: "US Dollars", minor: "Cents" },
  EUR: { symbol: "€", major: "Euros", minor: "Cents" },
  GBP: { symbol: "£", major: "Pounds", minor: "Pence" },
  AED: { major: "Dirhams", minor: "Fils" },
  SGD: { symbol: "S$", major: "Singapore Dollars", minor: "Cents" },
  AUD: { symbol: "A$" },
  BRL: { symbol: "R$" },
  CAD: { symbol: "CA$" },
  CNY: { symbol: "CN¥" },
  HKD: { symbol: "HK$" },
  ILS: { symbol: "₪" },
  JPY: { symbol: "¥", major: "Yen" },
  KRW: { symbol: "₩" },
  MXN: { symbol: "MX$" },
  NZD: { symbol: "NZ$" },
  PHP: { symbol: "₱" },
  TWD: { symbol: "NT$" },
  VND: { symbol: "₫" },
  XCD: { symbol: "EC$" },
};

const words = (list: string) => new Set(list.split(/\s+/));
const ZERO = words(ZERO_DECIMALS);
const THREE = words(THREE_DECIMALS);
/** The home currency of a profile stored before companies chose theirs, and of one never saved. */
export const KIN_DEFAULT_HOME_CURRENCY = "INR";
/** Every ISO 4217 code Kin accepts. */
export const KIN_CURRENCY_CODES: ReadonlySet<string> = words(CODES);
export const isKinCurrency = (code: string) => KIN_CURRENCY_CODES.has(code);
/** Every code whose minor units are `decimals` below its major one. */
export const kinCurrenciesWithDecimals = (decimals: number): ReadonlyArray<string> =>
  [...KIN_CURRENCY_CODES].filter(
    (code) => (ZERO.has(code) ? 0 : THREE.has(code) ? 3 : 2) === decimals,
  );

/** A currency's description; an unknown code reads as its code with two decimals. */
export const kinCurrency = (code: string): KinCurrencyInfo => {
  const row = ROWS[code] ?? {};
  return {
    code,
    decimals: ZERO.has(code) ? 0 : THREE.has(code) ? 3 : 2,
    symbol: row.symbol ?? `${code}\u00a0`,
    grouping: row.grouping ?? "western",
    major: row.major ?? code,
    minor: row.minor ?? "",
  };
};

/** Digits grouped with commas: thousands, or lakh and crore (12,34,567). */
export const kinGroupDigits = (digits: string, grouping: KinCurrencyInfo["grouping"]) =>
  grouping === "indian" && digits.length > 3
    ? `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`
    : digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const SCALES = {
  indian: [
    [1e7, "Cr"],
    [1e5, "L"],
    [1e3, "K"],
  ],
  western: [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ],
} as const;
const trimmed = (value: number) => {
  const text = value.toFixed(2);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
};
/** A size for an axis: `4.2L` and `1.5Cr` when grouped the Indian way, `4.2K` and `1.5M` otherwise. */
export const kinCompactNumber = (value: number, grouping: KinCurrencyInfo["grouping"]) => {
  const scale = SCALES[grouping].find(([at]) => value >= at);
  return scale === undefined ? trimmed(value) : `${trimmed(value / scale[0])}${scale[1]}`;
};

export interface KinMoneyFormat {
  /** "always" writes every minor digit (`₹1,200.00`), "some" only when they aren't all zero. */
  readonly cents?: "always" | "some";
  /** "compact" is for a chart axis: `₹4.2L`, `$1.5M`; never exact. */
  readonly style?: "full" | "compact";
  /** The bare exact number a spreadsheet or a form field takes: `-1200.50`, no symbol or grouping. */
  readonly bare?: boolean;
  readonly minus?: string;
}

/** An exact amount as people read it: `₹4,20,000.00`, `$1,200.50`, `¥1,200`, `-PKR 1,500`. */
export const formatKinMoney = (
  minor: number | bigint,
  currency: string,
  format: KinMoneyFormat = {},
): string => {
  const info = kinCurrency(currency);
  const value = BigInt(minor);
  const size = value < 0n ? -value : value;
  const sign = value < 0n ? (format.minus ?? "-") : "";
  const unit = 10n ** BigInt(info.decimals);
  if (format.style === "compact") {
    return `${sign}${info.symbol}${kinCompactNumber(Number(size) / Number(unit), info.grouping)}`;
  }
  const part = size % unit;
  const fraction =
    info.decimals > 0 && (format.cents === "always" || part !== 0n)
      ? `.${part.toString().padStart(info.decimals, "0")}`
      : "";
  const whole = (size / unit).toString();
  return format.bare === true
    ? `${sign}${whole}${fraction}`
    : `${sign}${info.symbol}${kinGroupDigits(whole, info.grouping)}${fraction}`;
};

const escape = (text: string) => text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
// Every symbol a currency is written with, plus the ways people type the common ones, longest
// first so "A$" is read before "$" and "US$" before both.
const NAMED: ReadonlyArray<readonly [RegExp, string]> = [
  ...Object.entries(ROWS).flatMap(([code, row]) =>
    row.symbol === undefined ? [] : [[row.symbol, code] as const],
  ),
  ["US$", "USD"] as const,
]
  .sort(([a], [b]) => b.length - a.length)
  .map(([symbol, code]) => [new RegExp(`(?<!\\p{L})${escape(symbol)}`, "gu"), code] as const);
const SPOKEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brs\.?(?=\s|\d|$)|\brupees?\b/giu, "INR"],
];
const MULTIPLIERS: ReadonlyArray<readonly [RegExp, bigint]> = [
  [/\b(?:crores?|cr)\b/giu, 10_000_000n],
  [/\b(?:lakhs?|lacs?|lakh)\b/giu, 100_000n],
  [/\b(?:millions?|mn)\b/giu, 1_000_000n],
  [/\b(?:thousand|k)\b|(?<=\d)k\b/giu, 1_000n],
];
// Read in an amount only, never when spotting money in a title, where "5 m" or "10L" is a size.
const SHORT_MULTIPLIERS: ReadonlyArray<readonly [RegExp, bigint]> = [
  [/(?<=\d\s?)m\b/giu, 1_000_000n],
  [/(?<=\d\s?)l\b/giu, 100_000n],
];
// A rough figure is still the figure: "~90k", "about 9 lakh".
const ROUGHLY = /^(?:~|≈|about|around|approx\.?|approximately|roughly|nearly|almost)\s*/iu;

// Commas and dots read one way only: thousands, lakh and crore, or a decimal comma that has
// exactly the currency's decimals after it. Our own grouped forms win where two would fit.
const GROUPED = [
  /^(\d{1,18})(?:\.(\d{1,18}))?$/u,
  /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,18}))?$/u,
  /^(\d{1,2}(?:,\d{2})*,\d{3})(?:\.(\d{1,18}))?$/u,
];
const readFigure = (number: string, decimals: number) => {
  const comma =
    decimals === 0
      ? undefined
      : new RegExp(`^(\\d{1,3}(?:\\.\\d{3})+|\\d+),(\\d{${decimals}})$`, "u");
  const found = [...GROUPED, ...(comma === undefined ? [] : [comma])]
    .map((shape) => shape.exec(number))
    .find((match) => match !== null);
  return found === undefined
    ? undefined
    : { whole: found[1]!.replace(/[,.]/gu, ""), fraction: found[2] ?? "" };
};

/**
 * A spoken or written amount in minor units: "4.2 lakh", "₹1,23,456.78", "$12.5", "1.5 crore",
 * "12k", "9L", "1.2m", "~90k", "about 90k", "JPY 1500", "-20", "1.234,56 EUR". The currency is the one the text names, else
 * `fallback`; naming two, a grouping that reads no one way, more decimals than the currency has,
 * or a figure past a safe integer is refused with why. Below zero is the caller's to take or not.
 */
export const parseKinMoney = (
  text: string,
  fallback: string,
): { readonly money: KinMoney } | { readonly error: string } => {
  let rest = text.trim().replace(/\/-$/u, "").replace(ROUGHLY, "");
  const named = new Set<string>();
  for (const [pattern, code] of [...NAMED, ...SPOKEN])
    rest = rest.replace(pattern, () => {
      named.add(code);
      return " ";
    });
  rest = rest.replace(/\b[A-Za-z]{3}\b/gu, (word) => {
    const code = word.toUpperCase();
    if (!isKinCurrency(code)) return word;
    named.add(code);
    return " ";
  });
  let multiplier = 1n;
  for (const [pattern, factor] of [...MULTIPLIERS, ...SHORT_MULTIPLIERS])
    rest = rest.replace(pattern, () => {
      multiplier *= factor;
      return " ";
    });
  const signed = rest.replace(/[\s_]/gu, "");
  const negative = /^[-\u2212]/u.test(signed);
  const number = negative ? signed.slice(1) : signed;
  const quoted = text.slice(0, 40);
  if (named.size > 1) return { error: `${quoted} names two currencies. Give one amount.` };
  const currency = named.values().next().value ?? fallback;
  if (!isKinCurrency(currency))
    return { error: `${currency.slice(0, 10)} is not a currency code such as USD.` };
  const { decimals, grouping } = kinCurrency(currency);
  const found = readFigure(number, decimals);
  if (found === undefined) {
    const digits = number.replace(/[,.]/gu, "");
    if (/^\d{1,18}$/u.test(digits) && digits !== number)
      return {
        error: `${quoted} is not an amount. Write it as ${digits} or ${
          decimals > 0 && digits.length > decimals
            ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
            : kinGroupDigits(digits, grouping)
        }.`,
      };
    return { error: `${quoted} is not an amount. Give a number such as 4200, 4,200.50 or 12k.` };
  }
  const { fraction } = found;
  const scaled = BigInt(found.whole + fraction) * multiplier * 10n ** BigInt(decimals);
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n)
    return {
      error: `${quoted} has more decimals than ${currency} has; round it to ${decimals}.`,
    };
  const minor = scaled / divisor;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER))
    return { error: `${quoted} is too large an amount.` };
  return { money: { minor: Number(negative ? -minor : minor), currency } };
};

const EDGES = /^[("'“‘[]+|[)"'”’\]:;,!?]+$|\.$/gu;
/**
 * Whether free text holds a figure `parseKinMoney` reads as money by its marks alone: a symbol,
 * a code, a currency word or a multiplier ("₹4,200", "0 INR", "45k"). A bare "4,200 owed" isn't,
 * and a three-letter code counts only in capitals, so "try 3 options" stays words.
 */
export const mentionsKinMoney = (text: string) => {
  const words = text.split(/[\s/]+/u).map((word) => word.replace(EDGES, ""));
  const near = (word: string | undefined) =>
    word === undefined || (/^[a-z]{3}$/iu.test(word) && word !== word.toUpperCase()) ? "" : word;
  return words.some((word, index) => {
    if (!/\d/u.test(word)) return false;
    const [before, after] = [near(words[index - 1]), near(words[index + 1])];
    return [`${before} ${word} ${after}`, `${before} ${word}`, `${word} ${after}`, word].some(
      (said) =>
        "money" in parseKinMoney(said, "XXX") ||
        (MULTIPLIERS.some(([pattern]) => said.search(pattern) >= 0) &&
          "money" in parseKinMoney(said, "USD")),
    );
  });
};
