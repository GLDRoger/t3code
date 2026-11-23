/**
 * What a country decides for a statement from it: the ways an expense is paid, how a numeric date
 * is ordered, which currency an unlabelled statement is in, the banks it may name and the payment
 * rails its narrations start with. What it decides for a company in it is `work/region.ts`.
 */

export type DateOrder = "dmy" | "mdy";

export interface StatementRegion {
  readonly currency: string;
  /** How an expense here is paid, as the expenses template offers it. */
  readonly paidWith: ReadonlyArray<string>;
  readonly dateOrder: DateOrder;
  /** Banks of this country, as their statements name them: the name to show. */
  readonly banks: ReadonlyArray<readonly [RegExp, string]>;
  /** Something only this country's statements print, such as an IFSC code. */
  readonly marker?: RegExp;
  /** Payment rails a narration starts with, lower case: "upi", "ach". */
  readonly rails: ReadonlyArray<string>;
}

const INDIA: StatementRegion = {
  // oxlint-disable-next-line t3code/kin-one-format -- the region descriptor is where India's currency lives.
  currency: "INR",
  paidWith: ["card", "upi", "bank", "cash"],
  dateOrder: "dmy",
  banks: [
    [/\bhdfc\b/i, "HDFC Bank"],
    [/\bicici\b/i, "ICICI Bank"],
    [/\baxis bank\b/i, "Axis Bank"],
    [/\bkotak\b/i, "Kotak Mahindra Bank"],
    [/\bstate bank of india\b|\bsbi\b/i, "State Bank of India"],
    [/\byes bank\b/i, "Yes Bank"],
    [/\bidfc first\b/i, "IDFC FIRST Bank"],
    [/\bindusind\b/i, "IndusInd Bank"],
    [/\brbl bank\b/i, "RBL Bank"],
    [/\bfederal bank\b/i, "Federal Bank"],
    [/\bbank of baroda\b/i, "Bank of Baroda"],
    [/\bpunjab national bank\b/i, "Punjab National Bank"],
    [/\bcanara bank\b/i, "Canara Bank"],
    [/\bunion bank of india\b/i, "Union Bank of India"],
    [/\bau small finance\b/i, "AU Small Finance Bank"],
  ],
  marker: /\bifsc\b|\b[A-Z]{4}0[A-Z0-9]{6}\b/,
  rails: ["upi", "neft", "imps", "rtgs", "nach", "ecs", "p2m", "p2a"],
};
const US: StatementRegion = {
  currency: "USD",
  paidWith: ["card", "ach", "wire", "check", "cash"],
  dateOrder: "mdy",
  banks: [
    [/\bchase\b/i, "Chase"],
    [/\bbank of america\b/i, "Bank of America"],
    [/\bwells fargo\b/i, "Wells Fargo"],
    [/\bcapital one\b/i, "Capital One"],
  ],
  marker: /\brouting (?:no|number)\b|\baba\b/i,
  rails: ["ach", "zelle", "wire", "venmo"],
};
const UK: StatementRegion = {
  currency: "GBP",
  paidWith: ["card", "bank", "direct debit", "cash"],
  dateOrder: "dmy",
  banks: [
    [/\bbarclays\b/i, "Barclays"],
    [/\blloyds\b/i, "Lloyds Bank"],
    [/\bnatwest\b/i, "NatWest"],
    [/\bmonzo\b/i, "Monzo"],
  ],
  marker: /\bsort code\b/i,
  rails: ["bacs", "chaps", "fps", "dd"],
};
const STATEMENT_REGIONS: ReadonlyArray<StatementRegion> = [INDIA, US, UK];

/** Banks in many countries: named on a statement, they say nothing of its country. */
const GLOBAL_BANKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bstandard chartered\b/i, "Standard Chartered"],
  [/\bhsbc\b/i, "HSBC"],
  [/\bamerican express\b/i, "American Express"],
  [/\bciti(?:bank)?\b/i, "Citibank"],
];

/** The bank a statement names, and its country when the bank has one. */
export const bankIn = (text: string) => {
  for (const region of STATEMENT_REGIONS)
    for (const [pattern, name] of region.banks)
      if (pattern.test(text)) return { name, region } as const;
  const global = GLOBAL_BANKS.find(([pattern]) => pattern.test(text));
  return global === undefined ? undefined : ({ name: global[1], region: undefined } as const);
};

/** The country a statement's own text names by its bank or a marker only that country prints. */
export const regionNamedIn = (text: string) =>
  bankIn(text)?.region ??
  STATEMENT_REGIONS.find((region) => region.marker !== undefined && region.marker.test(text));

/** The company's region, by its home currency; none for a currency no row has. */
export const companyRegion = (home: string): StatementRegion | undefined =>
  STATEMENT_REGIONS.find((region) => region.currency === home);

/** How an expense is paid where no region says: ways every country has. */
export const NEUTRAL_PAID_WITH: ReadonlyArray<string> = ["card", "bank", "cash"];

/**
 * The region a statement reads in: the one its text names, else the company's by its home
 * currency, else one with the home currency and day-first dates, as most of the world writes them.
 */
export const statementRegion = (text: string, home: string): StatementRegion =>
  regionNamedIn(text) ??
  companyRegion(home) ?? {
    currency: home,
    paidWith: NEUTRAL_PAID_WITH,
    dateOrder: "dmy",
    banks: [],
    rails: [],
  };

/** Every region's rails: stripping one from a narration is harmless wherever it was written. */
export const RAILS: ReadonlyArray<string> = [
  ...new Set(STATEMENT_REGIONS.flatMap((region) => region.rails)),
];
/** The currencies offered when a statement proves none, the home one first. */
export const likelyCurrencies = (home: string) => [
  ...new Set([home, ...STATEMENT_REGIONS.map((region) => region.currency), "EUR", "AED", "SGD"]),
];

const NUMERIC = /^(\d{1,2})[/.-](\d{1,2})[/.-](?:\d{4}|\d{2})(?:$|[\s|,T])/;

/**
 * How a statement orders its numeric dates. The statement decides when it can: a first part
 * above 12 anywhere means day first, a second part above 12 month first. Only when every date
 * fits both does `fallback`, the region's order, decide.
 */
export const dateOrderIn = (dates: Iterable<string>, fallback: DateOrder): DateOrder => {
  let dayFirst = false;
  let monthFirst = false;
  for (const said of dates) {
    const found = NUMERIC.exec(said.trim());
    if (found === null) continue;
    if (Number(found[1]) > 12) dayFirst = true;
    if (Number(found[2]) > 12) monthFirst = true;
  }
  return dayFirst === monthFirst ? fallback : dayFirst ? "dmy" : "mdy";
};
