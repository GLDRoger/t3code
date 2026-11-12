import type { Money, Value } from "./recipe.ts";

/**
 * A recipe's computed fields: every figure a document shows that Kin doesn't store, worked out
 * here in exact integers from the inputs, by a fixed set of functions a recipe names in order.
 * Templates only lay out what this returns, so no sum is ever the model's or a template's.
 */

export type Computed = Readonly<Record<string, unknown>>;
type Scope = Readonly<Record<string, unknown>>;
type Spec = Readonly<Record<string, unknown>>;

// Thrown inside the pure evaluator and caught once by `computeData`, never into Effect code.
// @effect-diagnostics-next-line extendsNativeError:off
class ComputeError extends Error {}
const fail = (message: string): never => {
  throw new ComputeError(message);
};

/**
 * What one computation may do and make, sized for a year of rows (50,000 by 40 columns) worked
 * over a few times: past either, the fields would hold the server up before Typst even starts.
 */
const COMPUTE_BUDGET = {
  operations: 25_000_000,
  values: 12_000_000,
  bytes: 256 * 1024 * 1024,
};
const tooLarge = () =>
  fail(
    "this recipe's computed fields grow too large for Kin to work out: keep each field to the rows and columns it needs",
  );
// The evaluator is synchronous, so one counter per `computeData` call can't interleave with another.
let operations = 0;
const spend = (count: number) => {
  operations += count;
  if (operations > COMPUTE_BUDGET.operations) tooLarge();
};

/** The functions a computed field may name; each spec is one of these as its only key. */
export const FUNCTIONS = [
  "times",
  "percent",
  "sum",
  "minus",
  "first",
  "each",
  "words",
  "date",
  "gst",
  "markdown",
] as const;
const ROUNDINGS = ["half-up", "half-even", "down", "up"] as const;
type Rounding = (typeof ROUNDINGS)[number];

const isMoney = (value: unknown): value is Money =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "minor") === "number" &&
  typeof Reflect.get(value, "currency") === "string";
const money = (minor: bigint, currency: string): Money => {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER))
    fail("an amount is too large to show exactly");
  return { minor: Number(minor), currency };
};

/** A decimal as an exact fraction: "1.5" is 15/10. */
const fraction = (value: unknown): { readonly num: bigint; readonly den: bigint } => {
  const text = typeof value === "number" ? String(value) : value;
  const match =
    typeof text === "string" ? /^\s*(-?)(\d{1,15})(?:\.(\d{1,9}))?\s*$/.exec(text) : null;
  if (match === null) return fail(`${String(text).slice(0, 40)} isn't a number`);
  const digits = match[3] ?? "";
  return {
    num: BigInt(`${match[1]}${match[2]}${digits}`),
    den: 10n ** BigInt(digits.length),
  };
};
const decimalText = (num: bigint, den: bigint): string => {
  // Shortest exact decimal of num/den, up to 9 places: 9/1 is "9", 25/10 "2.5".
  let scale = 1n;
  let digits = 0;
  while ((num * scale) % den !== 0n && digits < 9) {
    scale *= 10n;
    digits += 1;
  }
  const whole = (num * scale) / den;
  const negative = whole < 0n;
  const text = (negative ? -whole : whole).toString().padStart(digits + 1, "0");
  const out = digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  return negative ? `-${out}` : out;
};

/** num/den to a whole number by the rule; the default rounds halves away from zero. */
const divide = (num: bigint, den: bigint, rounding: Rounding = "half-up"): bigint => {
  if (den === 0n) return fail("a division by zero");
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const up =
    r === 0n
      ? false
      : rounding === "up"
        ? true
        : rounding === "down"
          ? false
          : rounding === "half-even"
            ? 2n * r > b || (2n * r === b && q % 2n === 1n)
            : 2n * r >= b;
  const magnitude = up ? q + 1n : q;
  return negative ? -magnitude : magnitude;
};

const CURRENCIES: Readonly<
  Record<
    string,
    {
      readonly symbol: string;
      readonly major: string;
      readonly minor: string;
      readonly indian: boolean;
    }
  >
> = {
  INR: { symbol: "₹", major: "Rupees", minor: "Paise", indian: true },
  USD: { symbol: "US$", major: "US Dollars", minor: "Cents", indian: false },
  EUR: { symbol: "€", major: "Euros", minor: "Cents", indian: false },
  GBP: { symbol: "£", major: "Pounds", minor: "Pence", indian: false },
  AED: { symbol: "AED ", major: "Dirhams", minor: "Fils", indian: false },
  SGD: { symbol: "S$", major: "Singapore Dollars", minor: "Cents", indian: false },
};
const currencyOf = (code: string) =>
  CURRENCIES[code] ?? { symbol: `${code} `, major: code, minor: "Cents", indian: false };

const group = (digits: string, indian: boolean) => {
  if (!indian || digits.length <= 3) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`;
};
/** "₹1,18,000.00" from paise. */
const formatMoney = (value: Money) => {
  const minor = BigInt(value.minor);
  const abs = minor < 0n ? -minor : minor;
  const c = currencyOf(value.currency);
  return `${minor < 0n ? "-" : ""}${c.symbol}${group((abs / 100n).toString(), c.indian)}.${(abs % 100n).toString().padStart(2, "0")}`;
};

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const belowHundred = (n: number) =>
  n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]!}${n % 10 > 0 ? ` ${ONES[n % 10]!}` : ""}`;
const belowThousand = (n: number) =>
  [
    n >= 100 ? `${ONES[Math.floor(n / 100)]!} Hundred` : "",
    n % 100 > 0 ? belowHundred(n % 100) : "",
  ]
    .filter(Boolean)
    .join(" ");
/** A whole number in words: lakh and crore when Indian, million and billion otherwise. */
const inWords = (value: bigint, indian: boolean): string => {
  let n = value;
  if (n === 0n) return "Zero";
  const parts: Array<string> = [];
  if (indian) {
    const crore = n / 10_000_000n;
    n %= 10_000_000n;
    if (crore > 0n) parts.push(`${inWords(crore, true)} Crore`);
    const lakh = Number(n / 100_000n);
    n %= 100_000n;
    if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
    const thousand = Number(n / 1000n);
    n %= 1000n;
    if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  } else
    for (const [size, name] of [
      [1_000_000_000n, "Billion"],
      [1_000_000n, "Million"],
      [1000n, "Thousand"],
    ] as const) {
      const count = n / size;
      n %= size;
      if (count > 0n) parts.push(`${inWords(count, false)} ${name}`);
    }
  if (n > 0n) parts.push(belowThousand(Number(n)));
  return parts.join(" ");
};
/** "Rupees One Thousand and Ninety Nine Paise Only". */
const amountInWords = (value: Money) => {
  const c = currencyOf(value.currency);
  const minor = BigInt(value.minor);
  const abs = minor < 0n ? -minor : minor;
  const words = `${minor < 0n ? "Minus " : ""}${c.major} ${inWords(abs / 100n, c.indian)}`;
  const cents = abs % 100n;
  return `${cents > 0n ? `${words} and ${inWords(cents, c.indian)} ${c.minor}` : words} Only`;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DATE_FORMATS = ["D MMM YYYY", "D MMMM YYYY", "DD/MM/YYYY", "MMMM YYYY"] as const;
const formatDate = (day: string, format: string) => {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(day);
  if (match === null) return fail(`${day.slice(0, 20)} isn't a day`);
  const [, y, m, d = "01"] = match;
  const month = MONTHS[Number(m) - 1] ?? fail(`${day} isn't a day`);
  switch (format) {
    case "D MMM YYYY":
      return `${Number(d)} ${month.slice(0, 3)} ${y}`;
    case "D MMMM YYYY":
      return `${Number(d)} ${month} ${y}`;
    case "DD/MM/YYYY":
      return `${d}/${m}/${y}`;
    case "MMMM YYYY":
      return `${month} ${y}`;
    default:
      return fail(`date formats are ${DATE_FORMATS.join(", ")}`);
  }
};

/** GST state codes, as the first two digits of a GSTIN. */
const STATES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
};
// Union territories without a legislature charge UTGST in place of SGST.
const UT_WITHOUT_LEGISLATURE = new Set(["04", "26", "31", "35", "38"]);
const letters = (text: string) => text.toLowerCase().replace(/[^a-z]/g, "");
/** A state code from a GSTIN or a place; `null` when neither is given, `undefined` abroad. */
const stateOf = (gstin: unknown, place: unknown): string | null | undefined => {
  if (typeof gstin === "string" && gstin.length > 0) return gstin.slice(0, 2);
  if (typeof place !== "string" || place.trim() === "") return null;
  const code = /^\s*(\d{2})\b/.exec(place)?.[1];
  if (code !== undefined && STATES[code] !== undefined) return code;
  const wanted = letters(place);
  for (const [key, name] of Object.entries(STATES)) if (letters(name) === wanted) return key;
  if (wanted === "orissa") return "21";
  if (wanted === "pondicherry") return "34";
  return undefined;
};
const stateName = (code: string) => `${STATES[code] ?? code} (${code})`;

/**
 * The GST on a supply, split by where the two parties are: CGST and SGST (or UTGST) within a
 * state, IGST between states, none on an export under a letter of undertaking or from a seller
 * with no GSTIN. From the taxable value when there is one, else out of the tax-inclusive total,
 * keeping a recorded tax exactly.
 */
const gst = (args: {
  readonly taxable: Money | null;
  readonly total: Money | null;
  readonly recordedTax: Money | null;
  readonly rate: string;
  readonly supplierGstin: unknown;
  readonly supplierPlace: unknown;
  readonly clientGstin: unknown;
  readonly clientPlace: unknown;
  readonly exportUnderLut: boolean;
}) => {
  const registered = typeof args.supplierGstin === "string" && args.supplierGstin.length > 0;
  const supplier = stateOf(args.supplierGstin, args.supplierPlace);
  const client = stateOf(args.clientGstin, args.clientPlace);
  const exported = client === undefined;
  if (registered && client === null)
    fail("the client has no place of supply: give it a GSTIN or a place of supply");
  if (registered && (supplier === null || supplier === undefined))
    fail("the company's state isn't known: set its GSTIN or place of supply");
  const rate = fraction(args.rate);
  const half = { num: rate.num, den: rate.den * 2n };
  const components: ReadonlyArray<{
    readonly name: string;
    readonly num: bigint;
    readonly den: bigint;
  }> = !registered
    ? []
    : exported
      ? args.exportUnderLut
        ? []
        : [{ name: "IGST", ...rate }]
      : supplier === client
        ? [
            { name: "CGST", ...half },
            { name: UT_WITHOUT_LEGISLATURE.has(client!) ? "UTGST" : "SGST", ...half },
          ]
        : [{ name: "IGST", ...rate }];
  const currency = args.taxable?.currency ?? args.total?.currency ?? "INR";
  for (const one of [args.taxable, args.total, args.recordedTax])
    if (one !== null && one.currency !== currency) fail(`every amount must be in ${currency}`);
  let taxable: bigint;
  let amounts: ReadonlyArray<bigint>;
  if (args.taxable !== null) {
    taxable = BigInt(args.taxable.minor);
    amounts = components.map((one) => divide(taxable * one.num, one.den * 100n));
    const grand = taxable + amounts.reduce((sum, one) => sum + one, 0n);
    if (args.total !== null && BigInt(args.total.minor) !== grand)
      fail(
        `the lines come to ${formatMoney(money(grand, currency))} with tax, but the entry is recorded at ${formatMoney(args.total)}: correct the lines or the entry's amount`,
      );
  } else {
    if (args.total === null) return fail("there is no amount and no lines");
    const whole = BigInt(args.total.minor);
    if (args.recordedTax !== null && components.length === 0 && args.recordedTax.minor !== 0)
      fail(
        `the entry records tax, but this invoice carries none (${registered ? "an export" : "no GSTIN"})`,
      );
    // Sum of the component rates as one fraction over a common denominator.
    const den = components.reduce((d, one) => (one.den > d ? one.den : d), 1n);
    const rates = components.reduce((sum, one) => sum + one.num * (den / one.den), 0n);
    taxable =
      args.recordedTax !== null && components.length > 0
        ? whole - BigInt(args.recordedTax.minor)
        : divide(whole * 100n * den, 100n * den + rates);
    const tax = whole - taxable;
    // Split so the parts add up to the tax exactly.
    amounts = components.map((_, index) =>
      components.length === 2 ? (index === 0 ? tax / 2n : tax - tax / 2n) : tax,
    );
  }
  const tax = amounts.reduce((sum, one) => sum + one, 0n);
  return {
    registered,
    exported,
    exportUnderLut: exported && args.exportUnderLut,
    supplierState: supplier === null || supplier === undefined ? null : stateName(supplier),
    placeOfSupply: exported || client === null ? null : stateName(client),
    country: exported ? args.clientPlace : null,
    taxable: money(taxable, currency),
    taxes: components.map((one, index) => ({
      name: one.name,
      rate: decimalText(one.num, one.den),
      amount: money(amounts[index]!, currency),
    })),
    tax: money(tax, currency),
    total: money(taxable + tax, currency),
  };
};

export type Block =
  | { readonly kind: "heading"; readonly level: number; readonly spans: ReadonlyArray<Span> }
  | { readonly kind: "paragraph" | "quote"; readonly spans: ReadonlyArray<Span> }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: ReadonlyArray<ReadonlyArray<Span>>;
    }
  | {
      readonly kind: "table";
      readonly header: ReadonlyArray<string>;
      readonly numeric: ReadonlyArray<boolean>;
      readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Span>>>;
    }
  | { readonly kind: "chart"; readonly name: string };
export type Span = {
  readonly text: string;
  readonly style: "plain" | "strong" | "emph" | "code" | "link";
  readonly url?: string;
};

const INLINE =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
const spansOf = (text: string): ReadonlyArray<Span> => {
  const spans: Array<Span> = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index), style: "plain" });
    const token = match[0];
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
    if (token.startsWith("**") || token.startsWith("__"))
      spans.push({ text: token.slice(2, -2), style: "strong" });
    else if (token.startsWith("`")) spans.push({ text: token.slice(1, -1), style: "code" });
    else if (link !== null)
      spans.push(
        /^https?:\/\//.test(link[2]!)
          ? { text: link[1]!, style: "link", url: link[2]! }
          : { text: link[1]!, style: "plain" },
      );
    else spans.push({ text: token.slice(1, -1), style: "emph" });
    last = match.index + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), style: "plain" });
  return spans;
};
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
const ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

/** A Markdown subset as data: headings, paragraphs, lists, quotes, tables and chart lines. */
const markdownBlocks = (markdown: string): ReadonlyArray<Block> => {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: Array<Block> = [];
  let paragraph: Array<string> = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", spans: spansOf(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const chart = /^\s*\[chart:\s*([a-z0-9-]+)\s*\]\s*$/i.exec(line);
    const item = ITEM.exec(line);
    if (line.trim() === "") flush();
    else if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, spans: spansOf(heading[2]!) });
    } else if (chart !== null) {
      flush();
      blocks.push({ kind: "chart", name: chart[1]!.toLowerCase() });
    } else if (line.startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: Array<ReadonlyArray<string>> = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      i -= 1;
      blocks.push({
        kind: "table",
        header,
        numeric: header.map(
          (_, c) =>
            rows.length > 0 &&
            rows.every((row) => /^[-+]?[₹$€£]?[\d,]+(\.\d+)?%?$/.test(row[c] ?? "")),
        ),
        rows: rows.map((row) => header.map((_, c) => spansOf(row[c] ?? ""))),
      });
    } else if (item !== null) {
      flush();
      const items = [spansOf(item[2]!)];
      while (i + 1 < lines.length && ITEM.test(lines[i + 1]!))
        items.push(spansOf(ITEM.exec(lines[++i]!)![2]!));
      blocks.push({ kind: "list", ordered: /\d/.test(item[1]!), items });
    } else if (line.startsWith(">")) {
      flush();
      blocks.push({ kind: "quote", spans: spansOf(line.replace(/^>\s?/, "")) });
    } else paragraph.push(line.trim());
  }
  flush();
  return blocks;
};

const REF = /^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)?$/;

/** `name` or `table.column` (that column of every row); anything else is a literal. */
const resolve = (scope: Scope, arg: unknown): unknown => {
  if (typeof arg !== "string" || !REF.test(arg)) return arg;
  const [head, tail] = arg.split(".") as [string, string | undefined];
  if (!Object.hasOwn(scope, head)) return fail(`${arg} isn't an input or an earlier field`);
  const value = scope[head];
  if (tail === undefined) return value;
  if (Array.isArray(value)) spend(value.length);
  if (Array.isArray(value))
    return value.map((row: unknown) =>
      typeof row === "object" && row !== null ? Reflect.get(row, tail) : null,
    );
  return typeof value === "object" && value !== null ? (Reflect.get(value, tail) ?? null) : null;
};
const asMoney = (value: unknown, what: string): Money | null =>
  value === null || value === undefined
    ? null
    : isMoney(value)
      ? value
      : fail(`${what} isn't an amount`);
const argsOf = (spec: unknown, count: number, name: string): ReadonlyArray<unknown> =>
  Array.isArray(spec) && spec.length === count
    ? spec
    : fail(`${name} takes ${count} arguments in a list`);

const sumOf = (values: ReadonlyArray<unknown>, what: string): Money | null => {
  const amounts = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  spend(amounts.length);
  let total: bigint | null = null;
  let currency: string | null = null;
  for (const value of amounts) {
    const one = asMoney(value, what);
    if (one === null) continue;
    if (currency !== null && one.currency !== currency)
      fail(`${what} adds ${currency} and ${one.currency}`);
    currency = one.currency;
    total = (total ?? 0n) + BigInt(one.minor);
  }
  return total === null || currency === null ? null : money(total, currency);
};

/** One field's value from its spec, `{ <function>: <arguments> }`. */
const evaluate = (scope: Scope, name: string, spec: Spec): unknown => {
  const [fn, raw, ...extra] = Object.keys(spec);
  if (fn === undefined) return fail(`${name} names no function`);
  const options = new Set(fn === "percent" ? ["round"] : []);
  if ([raw, ...extra].some((key) => key !== undefined && !options.has(key)))
    return fail(`${name}: ${fn} takes no option ${[raw, ...extra].join(", ")}`);
  const arg = spec[fn];
  switch (fn) {
    case "times": {
      const [amount, factor] = argsOf(arg, 2, "times").map((one) => resolve(scope, one));
      const value = asMoney(amount, `${name}'s amount`);
      if (value === null || factor === null || factor === undefined) return null;
      const f = fraction(factor);
      return money(divide(BigInt(value.minor) * f.num, f.den), value.currency);
    }
    case "percent": {
      const [amount, rate] = argsOf(arg, 2, "percent").map((one) => resolve(scope, one));
      const rounding = spec.round ?? "half-up";
      if (!ROUNDINGS.includes(rounding as Rounding))
        return fail(`${name}: round is one of ${ROUNDINGS.join(", ")}`);
      const value = asMoney(amount, `${name}'s amount`);
      if (value === null || rate === null || rate === undefined) return null;
      const f = fraction(rate);
      return money(
        divide(BigInt(value.minor) * f.num, f.den * 100n, rounding as Rounding),
        value.currency,
      );
    }
    case "sum":
      return sumOf(
        (Array.isArray(arg) ? arg : [arg]).map((one) => resolve(scope, one)),
        name,
      );
    case "minus": {
      const [a, b] = argsOf(arg, 2, "minus").map((one) =>
        asMoney(resolve(scope, one), `${name}'s amounts`),
      );
      if (a === null || a === undefined) return null;
      if (b === null || b === undefined) return a;
      if (a.currency !== b.currency) fail(`${name} takes ${b.currency} from ${a.currency}`);
      return money(BigInt(a.minor) - BigInt(b.minor), a.currency);
    }
    case "first":
      return (
        (Array.isArray(arg) ? arg : [arg])
          .map((one) => resolve(scope, one))
          .find((value) => value !== null && value !== undefined && value !== "") ?? null
      );
    case "each": {
      if (typeof arg !== "object" || arg === null || Array.isArray(arg))
        return fail(`${name}: each takes { rows: <table>, set: { <column>: <field> } }`);
      const rows = resolve(scope, Reflect.get(arg, "rows"));
      const set: unknown = Reflect.get(arg, "set");
      if (rows === null || rows === undefined) return null;
      if (!Array.isArray(rows)) return fail(`${name}: rows isn't a table`);
      if (typeof set !== "object" || set === null) return fail(`${name}: each needs set`);
      // A row holds single values only, so no field can nest tables in tables and multiply them.
      const width = Object.keys(scope).length;
      return rows.map((row: unknown, index) => {
        const own = typeof row === "object" && row !== null ? { ...row } : {};
        spend(width + Object.keys(own).length + 1);
        if (!Object.values(own).every(isSingle))
          fail(`${name}: each runs over a table whose cells are single values`);
        const out: Record<string, unknown> = { ...own, n: index + 1 };
        const local: Record<string, unknown> = { ...scope, ...out };
        for (const [column, inner] of Object.entries(set)) {
          const value = field(local, `${name}.${column}`, inner);
          if (!isSingle(value))
            fail(
              `${name}.${column}: each sets one value per row, such as text, a number or an amount`,
            );
          out[column] = value ?? null;
          local[column] = out[column];
        }
        return out;
      });
    }
    case "words": {
      const value = asMoney(resolve(scope, arg), `${name}'s amount`);
      return value === null ? null : amountInWords(value);
    }
    case "date": {
      const [day, format] = argsOf(arg, 2, "date");
      const value = resolve(scope, day);
      if (value === null || value === undefined || value === "") return null;
      return typeof value === "string" && typeof format === "string"
        ? formatDate(value, format)
        : fail(`${name}: date takes a day and a format`);
    }
    case "gst": {
      if (typeof arg !== "object" || arg === null || Array.isArray(arg))
        return fail(`${name}: gst takes named arguments`);
      const get = (key: string) => resolve(scope, Reflect.get(arg, key) ?? null);
      const rate = get("rate");
      if (rate === null || rate === undefined) return fail(`${name}: gst needs a rate`);
      return gst({
        taxable: asMoney(get("taxable"), "taxable"),
        total: asMoney(get("total"), "total"),
        recordedTax: asMoney(get("recordedTax"), "recordedTax"),
        rate: String(rate),
        supplierGstin: get("supplierGstin"),
        supplierPlace: get("supplierPlace"),
        clientGstin: get("clientGstin"),
        clientPlace: get("clientPlace"),
        exportUnderLut: get("exportUnderLut") !== false,
      });
    }
    case "markdown": {
      const text = resolve(scope, arg);
      return typeof text === "string" ? markdownBlocks(text) : null;
    }
    default:
      return fail(`${name}: ${fn} isn't one of ${FUNCTIONS.join(", ")}`);
  }
};
const isSingle = (value: unknown) =>
  value === null ||
  value === undefined ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  isMoney(value);
const field = (scope: Scope, name: string, spec: unknown): unknown => {
  spend(1);
  return typeof spec === "object" && spec !== null && !Array.isArray(spec)
    ? evaluate(scope, name, spec as Spec)
    : resolve(scope, spec);
};

type Size = { readonly values: number; readonly bytes: number };
/**
 * How much `value` is once written out whole, each shared table counted every place it appears,
 * as JSON writes it; measured once per object, so a field that repeats another costs no more here.
 */
const sizeOf = (value: unknown, seen: WeakMap<object, Size>): Size => {
  if (typeof value === "string") return { values: 1, bytes: value.length + 2 };
  if (typeof value !== "object" || value === null) return { values: 1, bytes: 8 };
  const known = seen.get(value);
  if (known !== undefined) return known;
  spend(1);
  let values = 1;
  let bytes = 2;
  for (const [key, inner] of Object.entries(value)) {
    const size = sizeOf(inner, seen);
    values += size.values;
    bytes += size.bytes + key.length + 4;
    if (values > COMPUTE_BUDGET.values || bytes > COMPUTE_BUDGET.bytes) tooLarge();
  }
  const size = { values, bytes };
  seen.set(value, size);
  return size;
};

/** Every money value with its text as the document shows it, everywhere in `value`, once per object. */
const withText = (value: unknown, done: WeakMap<object, unknown>): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const known = done.get(value);
  if (known !== undefined) return known;
  spend(1);
  const out = isMoney(value)
    ? { minor: value.minor, currency: value.currency, text: formatMoney(value) }
    : Array.isArray(value)
      ? value.map((inner) => withText(inner, done))
      : Object.fromEntries(
          Object.entries(value).map(([key, inner]) => [key, withText(inner, done)]),
        );
  done.set(value, out);
  return out;
};

/**
 * What a template reads: the inputs and each computed field in order, money with its `text`.
 * A field that can't be worked out fails with a reason the agent and the owner can read.
 */
export const computeData = (
  inputs: Readonly<Record<string, Value>>,
  computed: ReadonlyArray<readonly [string, unknown]>,
): { readonly data: Computed } | { readonly error: string } => {
  const scope: Record<string, unknown> = { ...inputs };
  operations = 0;
  try {
    for (const [name, spec] of computed) scope[name] = field(scope, name, spec);
    sizeOf(scope, new WeakMap());
    return { data: withText(scope, new WeakMap()) as Computed };
  } catch (error) {
    if (error instanceof ComputeError) return { error: error.message };
    throw error;
  }
};
