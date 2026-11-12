import type { StatementRow } from "./statementTable.ts";

/**
 * Which invoice a credit pays and which expense a debit is, by plain rules: the exact amount
 * (or the amount less a usual TDS rate), the client's name or the invoice number in the
 * narration, the vendor, and the dates. Kin proposes; only the owner's confirm applies.
 */

export type InvoiceCandidate = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly paidMinor: number;
  /** GST on it, when the invoice says: TDS is deducted on the amount before tax. */
  readonly taxMinor: number | null;
  readonly issued: string | null;
  readonly client: string | null;
  readonly number: string | null;
};
export type ExpenseCandidate = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly currency: string;
  readonly amountMinor: number;
  /** Its own date, else when it falls due. */
  readonly day: string | null;
  readonly due: string | null;
  readonly open: boolean;
  readonly vendor: string | null;
  readonly repeats: boolean;
};
/** A past expense, to name a new one the way the owner named the last. */
export type KnownVendor = { readonly vendor: string; readonly category: string | null };

export type Candidate = {
  readonly kind: "invoice" | "expense";
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly fit: "exact" | "tds" | "part" | "foreign";
  /** The TDS a client deducted, when `fit` is tds. */
  readonly tdsMinor?: number;
  readonly score: number;
  readonly why: ReadonlyArray<string>;
};
export type Suggestion = {
  readonly action: "expense" | "transfer" | "ignore" | "later";
  readonly why?: string;
  readonly vendor?: string;
  readonly category?: string;
};
export type RowMatch = {
  readonly group: "matched" | "choose" | "unmatched";
  readonly candidates: ReadonlyArray<Candidate>;
  readonly suggestion: Suggestion;
};

/** Rates of TDS Indian clients commonly deduct (194J, 194C, 194H, 194I, 194Q). */
const TDS_RATES = [10, 2, 1, 5, 20, 0.1] as const;
/** TDS is rounded to the rupee, so a payment within this of the expected is the same. */
const TDS_SLACK_MINOR = 100;
/** One candidate this far ahead of the next is the answer; closer, the owner chooses. */
const CONFIDENT = 60;
const MARGIN = 20;
const PROPOSED = 30;

const STOP = new Set([
  "pvt",
  "private",
  "ltd",
  "limited",
  "llp",
  "inc",
  "the",
  "and",
  "co",
  "company",
  "corp",
  "corporation",
  "india",
  "services",
  "solutions",
  "technologies",
  "tech",
]);
const tokens = (text: string) =>
  text
    .toLowerCase()
    .replace(/\.(com|in|io|co|net|org)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word));
const squashed = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** How much of a name the narration carries, from 0 to 1. */
const nameIn = (name: string, narration: string) => {
  const wanted = tokens(name);
  if (wanted.length === 0) return 0;
  const said = new Set(tokens(narration));
  const flat = squashed(narration);
  const found = wanted.filter(
    (word) => said.has(word) || (word.length >= 5 && flat.includes(word)),
  );
  return found.length / wanted.length;
};

const DAY_MS = 86_400_000;
const dayNumber = (day: string) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

const invoiceCandidate = (
  row: StatementRow,
  invoice: InvoiceCandidate,
  currency: string,
): Candidate | undefined => {
  if (invoice.currency !== currency) return undefined;
  if (invoice.issued !== null && daysBetween(invoice.issued, row.date) < 0) return undefined;
  const balance = invoice.amountMinor - invoice.paidMinor;
  if (balance <= 0) return undefined;
  const why: Array<string> = [];
  let score = 0;
  let fit: Candidate["fit"] | undefined;
  let tdsMinor: number | undefined;
  if (row.amountMinor === balance) {
    fit = "exact";
    score += 50;
    why.push("same amount");
  } else if (invoice.paidMinor === 0 && row.amountMinor < balance) {
    const bases = [
      invoice.amountMinor,
      ...(invoice.taxMinor === null ? [] : [invoice.amountMinor - invoice.taxMinor]),
    ];
    for (const base of bases)
      for (const rate of TDS_RATES) {
        const tds = Math.round((base * rate) / 100);
        if (
          tdsMinor === undefined &&
          Math.abs(balance - tds - row.amountMinor) <= TDS_SLACK_MINOR
        ) {
          tdsMinor = balance - row.amountMinor;
          fit = "tds";
          score += 40;
          why.push(`${rate}% TDS deducted`);
        }
      }
  }
  const number = invoice.number ?? invoice.key;
  const numbered =
    [invoice.number, invoice.key]
      .filter((one): one is string => one !== null && squashed(one).length >= 4)
      .some((one) => squashed(row.description).includes(squashed(one))) ||
    (row.reference !== null &&
      squashed(number).length >= 4 &&
      squashed(row.reference).includes(squashed(number)));
  if (numbered) {
    score += 35;
    why.push("invoice number in the narration");
  }
  const named = invoice.client === null ? 0 : nameIn(invoice.client, row.description);
  if (named >= 0.5) {
    score += Math.round(30 * named);
    why.push("client named");
  }
  if (fit === undefined && row.amountMinor < balance && (numbered || named >= 0.5)) {
    fit = "part";
    score += 10;
    why.push("part of what is owed");
  }
  if (fit === undefined) return undefined;
  return {
    kind: "invoice",
    recordId: invoice.recordId,
    key: invoice.key,
    title: invoice.title,
    fit,
    ...(tdsMinor === undefined ? {} : { tdsMinor }),
    score,
    why,
  };
};

const expenseCandidate = (
  row: StatementRow,
  expense: ExpenseCandidate,
  currency: string,
): Candidate | undefined => {
  const foreign =
    row.foreign !== null &&
    expense.currency === row.foreign.currency &&
    expense.amountMinor === row.foreign.amountMinor;
  const exact = expense.currency === currency && expense.amountMinor === row.amountMinor;
  if (!foreign && !exact) return undefined;
  const day = expense.day ?? expense.due;
  if (day !== null) {
    const gap = daysBetween(day, row.date);
    if (gap < -10 || gap > 45) return undefined;
  }
  const why = [foreign ? `same ${expense.currency} amount` : "same amount"];
  let score = 50;
  const named = nameIn(expense.vendor ?? expense.title, row.description);
  if (named >= 0.5) {
    score += Math.round(30 * named);
    why.push("vendor named");
  }
  if (day !== null && Math.abs(daysBetween(day, row.date)) <= 3) {
    score += 10;
    why.push("same days");
  }
  if (
    expense.repeats &&
    expense.open &&
    expense.due !== null &&
    Math.abs(daysBetween(expense.due, row.date)) <= 5
  ) {
    score += 10;
    why.push("its usual billing day");
  }
  return {
    kind: "expense",
    recordId: expense.recordId,
    key: expense.key,
    title: expense.title,
    fit: foreign ? "foreign" : "exact",
    score,
    why,
  };
};

const TRANSFER =
  /\bself\b|own a\/?c|own account|to own|from own|sweep|\bfd\b|fixed deposit|credit card payment|\bcc (payment|pymt)|card payment|payment received|thank you|autopay|bill ?desk.*card/i;
const CHARGES =
  /chgs|charges|\bfees?\b|annual fee|gst on|sms chg|min(imum)? bal|cash handling|commission|penalty/i;
const TAX =
  /\bcbdt\b|\btds\b|\bgst ?(pmt|payment|challan)|\bgstn\b|advance tax|challan|income tax|\bitns\b/i;
const PAYROLL = /salary|\bsal\b|payroll|drawings?|reimburse/i;
const INTEREST = /\bint\.?\s?(pd|paid|cr)\b|interest|cashback|refund|reversal|\brev\b/i;
const CATEGORIES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\baws\b|amazon web|google ?(cloud|workspace|ads)|microsoft|github|notion|slack|zoom|adobe|openai|anthropic|figma|atlassian|digitalocean|vercel|cloudflare|heroku|netlify|dropbox|canva|linear|jetbrains|apple\.com|icloud|godaddy|namecheap|hostinger/i,
    "software",
  ],
  [
    /uber|\bola\b|rapido|makemytrip|irctc|indigo|vistara|air ?india|goibibo|cleartrip|\bhotel|oyo|fastag|petrol|fuel/i,
    "travel",
  ],
  [/swiggy|zomato|cafe|coffee|restaurant|chai|starbucks|dominos|eatsure|food/i, "meals"],
  [/\brent\b|lease|cowork|wework|91springboard/i, "rent"],
  [/croma|reliance digital|apple store|dell|lenovo|\bhp\b|vijay sales/i, "hardware"],
  [/amazon|flipkart|blinkit|zepto|bigbasket|dunzo|stationery|office/i, "office"],
];

/** Who a narration paid, from the way banks write UPI, card, NEFT and ACH lines. */
export const vendorOf = (narration: string): string | undefined => {
  const said = narration.replace(/\s+/g, " ").trim();
  const parts = (text: string) =>
    text
      .split(/[-/]/)
      .map((part) => part.trim())
      .filter(Boolean);
  let found: string | undefined;
  if (/^UPI[-/]/i.test(said)) {
    const pieces = parts(said);
    found = /^(DR|CR|P2M|P2A)$/i.test(pieces[1] ?? "") ? pieces[3] : pieces[1];
  } else if (/^(NEFT|IMPS|RTGS)\s?(DR|CR)?[-/]/i.test(said))
    found = parts(said).find(
      (piece, index) => index >= 2 && !/^\d+$/.test(piece) && !/^[A-Z]{4}0/i.test(piece),
    );
  else if (/^ACH\s?D?[-\s]/i.test(said)) found = said.replace(/^ACH\s?D?[-\s]+/i, "").split("-")[0];
  else if (/^POS\b/i.test(said)) found = said.replace(/^POS\s+\S*\d{4}\S*\s+/i, "");
  else found = said;
  const cleaned = (found ?? "")
    .replace(/\b(USD|EUR|GBP|SGD|AED|AUD|CAD)\s?[\d,.]+/gi, "")
    .replace(/\*.*$/, "")
    .replace(/\.(com|in|io|co)\b.*$/i, "")
    .replace(/@\S+/g, "")
    .replace(/[\d,.]{4,}/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
  if (cleaned.length < 2) return undefined;
  return cleaned
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bLlp\b/g, "LLP");
};

/** What an unmatched row likely is, for the owner's quick actions. */
export const suggest = (
  row: StatementRow,
  input: {
    readonly ownAccounts: ReadonlyArray<string>;
    readonly known: ReadonlyArray<KnownVendor>;
    readonly bank: string | null;
  },
): Suggestion => {
  const text = row.description;
  // A card spend names its own card, which is not a move between accounts.
  const ownAccount = /^POS\b/i.test(text)
    ? undefined
    : input.ownAccounts.find((last4) => new RegExp(`(?:x|\\*|•|\\d)${last4}\\b`, "i").test(text));
  if (ownAccount !== undefined || TRANSFER.test(text))
    return {
      action: "transfer",
      why:
        ownAccount === undefined
          ? "Looks like money moved between your own accounts"
          : `Looks like a move to or from your account ••${ownAccount}`,
    };
  if (row.direction === "credit")
    return INTEREST.test(text)
      ? { action: "ignore", why: "Interest, a refund or a reversal" }
      : { action: "later" };
  if (TAX.test(text))
    return { action: "expense", vendor: "Tax payment", category: "taxes", why: "A tax payment" };
  if (CHARGES.test(text))
    return {
      action: "expense",
      vendor: input.bank ?? "Bank charges",
      category: "fees",
      why: "Bank charges",
    };
  if (PAYROLL.test(text)) return { action: "ignore", why: "Salary, drawings or a reimbursement" };
  const guessed = vendorOf(text);
  const known = input.known
    .map((one) => ({ one, fit: nameIn(one.vendor, text) }))
    .filter((one) => one.fit >= 0.5)
    .toSorted((left, right) => right.fit - left.fit)[0]?.one;
  const category = known?.category ?? CATEGORIES.find(([pattern]) => pattern.test(text))?.[1];
  const vendor = known?.vendor ?? guessed;
  return {
    action: "expense",
    ...(vendor === undefined ? {} : { vendor }),
    ...(category === undefined || category === null ? {} : { category }),
    ...(known === undefined ? {} : { why: `You've paid ${known.vendor} before` }),
  };
};

/** Each row's candidates, best first, and whether one is clear enough to propose on its own. */
export const matchRows = (
  rows: ReadonlyArray<StatementRow>,
  input: {
    readonly currency: string;
    readonly invoices: ReadonlyArray<InvoiceCandidate>;
    readonly expenses: ReadonlyArray<ExpenseCandidate>;
    readonly ownAccounts: ReadonlyArray<string>;
    readonly known: ReadonlyArray<KnownVendor>;
    readonly bank: string | null;
  },
): ReadonlyArray<RowMatch> => {
  const taken = new Set<string>();
  const results = rows.map((row) => {
    const candidates = (
      row.direction === "credit"
        ? input.invoices.map((invoice) => invoiceCandidate(row, invoice, input.currency))
        : input.expenses.map((expense) => expenseCandidate(row, expense, input.currency))
    )
      .filter((one): one is Candidate => one !== undefined && one.score >= PROPOSED)
      .toSorted((left, right) => right.score - left.score || left.key.localeCompare(right.key))
      .slice(0, 5);
    return { row, candidates };
  });
  // One entry answers one row: the clearest claim keeps it, and the others see it as taken.
  const order = results
    .flatMap((result, index) =>
      result.candidates[0] === undefined ? [] : [{ index, score: result.candidates[0].score }],
    )
    .toSorted((left, right) => right.score - left.score || left.index - right.index);
  const settled = new Map<number, RowMatch>();
  for (const { index } of order) {
    const { row, candidates } = results[index]!;
    const open = candidates.filter((one) => !taken.has(one.recordId));
    const [best, next] = open;
    const clear =
      best !== undefined &&
      best.score >= CONFIDENT &&
      (next === undefined || best.score - next.score >= MARGIN);
    if (clear) taken.add(best.recordId);
    settled.set(index, {
      group: clear ? "matched" : open.length > 0 ? "choose" : "unmatched",
      candidates: clear ? [best] : open,
      suggestion: suggest(row, input),
    });
  }
  return results.map(
    ({ row }, index) =>
      settled.get(index) ?? { group: "unmatched", candidates: [], suggestion: suggest(row, input) },
  );
};
