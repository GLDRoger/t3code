import { currencyDigits, formatMinor } from "../money.ts";
import { RAILS } from "./statementRegion.ts";
import type { StatementRow } from "./statementTable.ts";
import { DAY_MS } from "../../durations.ts";
import { fold } from "../nameMatch.ts";
import { notAVendor } from "../vendorName.ts";

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
  /** Its amount and the payments it has from outside this statement (`seenOf`). */
  readonly seen: string;
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
  /** Its revision when read: Confirm applies nothing to one edited since. */
  readonly rev?: number;
};
/** A payment already recorded on an invoice, by hand or from another statement, with no bank row. */
export type PaymentCandidate = {
  readonly paymentId: string;
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly paidOn: string;
  readonly note: string;
  readonly client: string | null;
};
/** A partner the company owes, with their owed Paid expenses in one currency, oldest first. */
export type PartnerCandidate = {
  readonly name: string;
  /** Who they are, the same across their currencies: two partners can share a name. */
  readonly id?: string;
  /** Something stored that only they are, such as an imported address: in a narration, it is them. */
  readonly ids?: ReadonlyArray<string>;
  readonly currency: string;
  readonly owed: ReadonlyArray<Repaid>;
};
/** One owed expense as the card shows it, what Confirm checks is still so before marking it repaid. */
export type Repaid = {
  readonly recordId: string;
  readonly key: string;
  readonly amountMinor: number;
  /** Its own day, `YYYY-MM-DD`: a line before it can't have paid it back. */
  readonly day?: string;
  readonly rev?: number;
  /** Who funded it, the partner's `id`. */
  readonly by?: string;
};
/**
 * Anyone who has funded an expense, in any currency, owed or not, with the repayments marked by
 * hand (no bank row) as one total per currency and day: a line naming them is never a new expense.
 */
export type PayeeCandidate = {
  readonly name: string;
  readonly id?: string;
  readonly ids?: ReadonlyArray<string>;
  readonly repaid: ReadonlyArray<{
    readonly currency: string;
    readonly day: string;
    readonly amountMinor: number;
  }>;
};
/** A past expense, to name a new one the way the owner named the last. */
export type KnownVendor = { readonly vendor: string; readonly category: string | null };

/** An invoice's amount and its live payments by id, outside one statement: what a match stood on. */
export const seenOf = (amountMinor: number, paymentIds: ReadonlyArray<string>) =>
  `${amountMinor}:${paymentIds.toSorted().join(",")}`;

export type Candidate = {
  readonly kind: "invoice" | "expense";
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  /** `recorded`: the row is a payment already on the invoice, `paymentId`; nothing new is paid. */
  /** `open`: an open invoice offered for money nothing matched, only for the owner to pick. */
  readonly fit: "exact" | "tds" | "part" | "foreign" | "recorded" | "open";
  /** The TDS a client deducted, when `fit` is tds. */
  readonly tdsMinor?: number;
  readonly paymentId?: string;
  /** An invoice's `seen` when matched: a confirm once it moved records nothing. Older reviews lack it. */
  readonly seen?: string;
  readonly score: number;
  readonly why: ReadonlyArray<string>;
  /** An expense's revision when read, for an ordinary expense match. */
  readonly rev?: number;
  /** A partner's owed expenses this debit pays back, oldest first; `recordId` is the first's. */
  readonly repays?: ReadonlyArray<Repaid>;
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

/**
 * How much of a person's name the narration carries, from 0 to 1, in any script: a word of two
 * letters must stand alone; a long or non-Latin one may run into the words beside it.
 */
const personIn = (name: string, narration: string) => {
  const wanted = fold(name)
    .split(" ")
    .filter((word) => word.length >= 2 || /[^a-z0-9]/.test(word));
  if (wanted.length === 0) return 0;
  const said = fold(narration);
  const words = new Set(said.split(" "));
  const flat = said.replaceAll(" ", "");
  const found = wanted.filter(
    (word) =>
      words.has(word) || ((word.length >= 5 || /[^a-z0-9]/.test(word)) && flat.includes(word)),
  );
  return found.length / wanted.length;
};

const runsIn = (text: string) =>
  Array.from(text.toLowerCase().matchAll(/[\p{L}\p{M}]+|\p{N}+/gu), (found) => ({
    run: found[0],
    start: found.index,
    end: found.index + found[0].length,
  }));

/**
 * The whole number is in the text: its runs of letters and of digits in order, apart or touching,
 * with no letter or digit touching either end. "INV2" names INV-2; "INV26", "INV-2A" do not.
 */
const hasNumber = (text: string, number: string) => {
  const wanted = runsIn(number).map(({ run }) => run);
  if (wanted.join("").length < 4) return false;
  const runs = runsIn(text);
  return runs.some((first, at) => {
    const last = runs[at + wanted.length - 1];
    const before = runs[at - 1];
    const after = runs[at + wanted.length];
    return (
      last !== undefined &&
      wanted.every((run, step) => runs[at + step]!.run === run) &&
      (before === undefined || before.end < first.start) &&
      (after === undefined || last.end < after.start)
    );
  });
};

const dayNumber = (day: string) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

const invoiceCandidate = (
  row: StatementRow,
  invoice: InvoiceCandidate,
  currency: string,
  withholdsAtSource: boolean,
): Candidate | undefined => {
  // Money for an invoice in another currency is proved only by that amount in the narration.
  const foreign = invoice.currency !== currency;
  if (foreign && row.foreign?.currency !== invoice.currency) return undefined;
  const received = foreign ? row.foreign!.amountMinor : row.amountMinor;
  if (invoice.issued !== null && daysBetween(invoice.issued, row.date) < 0) return undefined;
  const balance = invoice.amountMinor - invoice.paidMinor;
  if (balance <= 0) return undefined;
  const why: Array<string> = [];
  let score = 0;
  let fit: Candidate["fit"] | undefined;
  let tdsMinor: number | undefined;
  if (foreign && received === balance) {
    fit = "foreign";
    score += 50;
    why.push(`same ${invoice.currency} amount`);
  } else if (foreign) {
    // A part or a TDS cut in another currency is the owner's to say.
  } else if (row.amountMinor === balance) {
    fit = "exact";
    score += 50;
    why.push("same amount");
  } else if (withholdsAtSource && invoice.paidMinor === 0 && row.amountMinor < balance) {
    // Withheld tax is rounded to the currency's whole unit, so a payment within one is the same.
    const slack = 10 ** currencyDigits(currency);
    const bases = [
      invoice.amountMinor,
      ...(invoice.taxMinor === null ? [] : [invoice.amountMinor - invoice.taxMinor]),
    ];
    for (const base of bases)
      for (const rate of TDS_RATES) {
        const tds = Math.round((base * rate) / 100);
        if (tdsMinor === undefined && Math.abs(balance - tds - row.amountMinor) <= slack) {
          tdsMinor = balance - row.amountMinor;
          fit = "tds";
          score += 40;
          why.push(`${rate}% TDS deducted`);
        }
      }
  }
  const number = invoice.number ?? invoice.key;
  const numbered =
    [invoice.number, invoice.key].some((one) => one !== null && hasNumber(row.description, one)) ||
    (row.reference !== null && hasNumber(row.reference, number));
  if (numbered) {
    score += 35;
    why.push("invoice number in the narration");
  }
  const named = invoice.client === null ? 0 : nameIn(invoice.client, row.description);
  if (named >= 0.5) {
    score += Math.round(30 * named);
    why.push("client named");
  }
  if (fit === undefined && !foreign && row.amountMinor < balance && (numbered || named >= 0.5)) {
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
    seen: invoice.seen,
    ...(tdsMinor === undefined ? {} : { tdsMinor }),
    score,
    why,
  };
};

/**
 * The candidates a statement's review keeps level with the best: within the margin that decides
 * whether one is the answer on its own. Scores best first.
 */
export const levelWithBest = <A>(ranked: ReadonlyArray<A>, score: (one: A) => number) =>
  ranked.filter((one) => score(ranked[0]!) - score(one) < MARGIN);

/** Whether the matcher takes a credit for money already recorded on an invoice, as a review does. */
export const paymentOffer = (row: StatementRow, payment: PaymentCandidate, currency: string) => {
  const offered = paymentCandidate(row, payment, currency);
  return offered === undefined || offered.score < PROPOSED ? undefined : offered;
};

/**
 * Whether the matcher would offer `invoice` for one bank row, as it does on a statement's review:
 * the candidate with its score, and why in one plain phrase: "cites INV/26-27/001", "same amount
 * from Harbourline Logistics".
 */
export const invoiceOffer = (
  row: StatementRow,
  invoice: InvoiceCandidate,
  currency: string,
  withholdsAtSource: boolean,
) => {
  const offered = invoiceCandidate(row, invoice, currency, withholdsAtSource);
  if (offered === undefined || offered.score < PROPOSED) return undefined;
  return { candidate: offered, reason: offerReason(row, invoice, currency, offered) };
};

const offerReason = (
  row: StatementRow,
  invoice: InvoiceCandidate,
  currency: string,
  offered: Candidate,
) => {
  const cited = [invoice.number, invoice.key].find(
    (one) =>
      one !== null &&
      (hasNumber(row.description, one) ||
        (row.reference !== null && hasNumber(row.reference, one))),
  );
  if (cited !== undefined && cited !== null) return `cites ${cited}`;
  const amount =
    offered.fit === "exact"
      ? "same amount"
      : offered.fit === "foreign"
        ? `same ${invoice.currency} amount`
        : offered.fit === "tds"
          ? `the amount less ${formatMinor(BigInt(offered.tdsMinor ?? 0), currency)} TDS`
          : "part of what is owed";
  return offered.why.includes("client named") ? `${amount} from ${invoice.client}` : amount;
};

const paymentCandidate = (
  row: StatementRow,
  payment: PaymentCandidate,
  currency: string,
): Candidate | undefined => {
  if (payment.currency !== currency || payment.amountMinor !== row.amountMinor) return undefined;
  const gap = daysBetween(payment.paidOn, row.date);
  if (gap < -10 || gap > 10) return undefined;
  const why = ["already recorded", "same amount"];
  let score = 40;
  if (
    row.reference !== null &&
    squashed(row.reference).length >= 6 &&
    squashed(payment.note).includes(squashed(row.reference))
  ) {
    score += 40;
    why.push("same reference");
  }
  const named = payment.client === null ? 0 : nameIn(payment.client, row.description);
  if (named >= 0.5) {
    score += Math.round(20 * named);
    why.push("client named");
  }
  if (Math.abs(gap) <= 3) {
    score += 10;
    why.push("same days");
  }
  return {
    kind: "invoice",
    recordId: payment.recordId,
    key: payment.key,
    title: payment.title,
    fit: "recorded",
    paymentId: payment.paymentId,
    score,
    why,
  };
};

const expenseCandidate = (
  row: StatementRow,
  expense: ExpenseCandidate,
  currency: string,
  transfer = false,
): Candidate | undefined => {
  const sign = row.direction === "credit" ? -1 : 1;
  const foreign =
    row.foreign !== null &&
    expense.currency === row.foreign.currency &&
    expense.amountMinor === sign * row.foreign.amountMinor;
  const exact = expense.currency === currency && expense.amountMinor === sign * row.amountMinor;
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
  const refund = row.direction === "credit";
  const numbered =
    refund &&
    (hasNumber(row.description, expense.key) ||
      (row.reference !== null && hasNumber(row.reference, expense.key)));
  if (numbered) {
    score += 35;
    why.push("expense reference in the narration");
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
    ...(expense.rev === undefined ? {} : { rev: expense.rev }),
    score: refund && (transfer || (named < 0.5 && !numbered)) ? PROPOSED : score,
    why,
  };
};

/** The narration carries a partner's whole name, or something stored that only they are. */
export const identifies = (partner: Pick<PartnerCandidate, "name" | "ids">, narration: string) =>
  personIn(partner.name, narration) === 1 ||
  (partner.ids ?? []).some(
    (id) => squashed(id).length >= 6 && squashed(narration).includes(squashed(id)),
  );

/** Most owed expenses one repayment is looked for across. */
const REPAYS_AT_MOST = 50;

/**
 * A line that settles with `partner` from their `from`th owed expense: the narration names them and
 * a run of their oldest owed expenses adds up to it exactly, refunds taking their part off. A debit
 * pays them back; a credit is theirs paying back a run that nets below zero. An amount alone may
 * be anyone's.
 */
export const repayment = (
  row: StatementRow,
  partner: PartnerCandidate,
  from: number,
  sure: boolean,
) => {
  const named = identifies(partner, row.description) ? 1 : personIn(partner.name, row.description);
  if (named < 0.5) return undefined;
  // Minor units past 2^53 add up wrong as numbers; exact sums decide what a line settles.
  const signed = BigInt(row.direction === "debit" ? row.amountMinor : -row.amountMinor);
  let sum = 0n;
  for (let end = from; end < Math.min(partner.owed.length, from + REPAYS_AT_MOST); end += 1) {
    const day = partner.owed[end]!.day;
    if (day !== undefined && day > row.date) break;
    sum += BigInt(partner.owed[end]!.amountMinor);
    if (sum !== signed) continue;
    const repays = partner.owed
      .slice(from, end + 1)
      .map((one) => (partner.id === undefined ? one : { ...one, by: partner.id }));
    const why = [`adds up to ${partner.name}'s oldest owed expenses`, "partner named"];
    let score = 40 + Math.round(30 * named);
    if (DRAWINGS.test(row.description)) {
      score += 10;
      why.push("says reimbursement");
    }
    // Part of a name, or a name two partners answer to, is the owner's to pick: never ticked.
    if (!sure) {
      score = Math.min(score, CONFIDENT - 1);
      why.push("the name could be someone else's");
    }
    const candidate: Candidate = {
      kind: "expense",
      recordId: repays[0]!.recordId,
      key: repays[0]!.key,
      title: `${row.direction === "debit" ? "Repays" : "Settles with"} ${partner.name}: ${repays.length} expense${repays.length === 1 ? "" : "s"}`,
      fit: "exact",
      score,
      why,
      repays,
    };
    return { candidate, next: end + 1 };
  }
  return undefined;
};

/**
 * Lines that settle with partners, in date order, each from after what earlier ones settled, so
 * successive lump sums settle successive expenses. Only a repayment that is its row's clear match
 * against `others` (the row's other candidates) moves past them; same-day debits are tried in any
 * order until none settles.
 */
const repayments = (
  rows: ReadonlyArray<StatementRow>,
  partners: ReadonlyArray<PartnerCandidate>,
  currency: string,
  others: (index: number) => ReadonlyArray<Candidate>,
  skip: (index: number) => boolean,
): ReadonlyMap<number, ReadonlyArray<Candidate>> => {
  const settled = partners.map(() => 0);
  const offers = (index: number) =>
    partners.flatMap((partner, at) => {
      if (partner.currency !== currency || skip(index)) return [];
      const offer = repayment(rows[index]!, partner, settled[at]!, sureOf(rows[index]!, partner));
      return offer === undefined ? [] : [{ at, ...offer }];
    });
  const clear = (index: number) => {
    const mine = offers(index);
    const [best, next] = [...mine.map((one) => one.candidate), ...others(index)].toSorted(
      (left, right) => right.score - left.score,
    );
    const won = mine.find((one) => one.candidate === best);
    return won !== undefined &&
      best!.score >= CONFIDENT &&
      (next === undefined || best!.score - next.score >= MARGIN)
      ? won
      : undefined;
  };
  const sureOf = (row: StatementRow, partner: PartnerCandidate) => {
    const whole = new Set(
      partners.filter((one) => identifies(one, row.description)).map((one) => one.id ?? one.name),
    );
    return whole.size === 1 && whole.has(partner.id ?? partner.name);
  };
  const found = new Map<number, ReadonlyArray<Candidate>>();
  const debits = rows
    .map((row, index) => ({ row, index }))
    .toSorted((a, b) =>
      a.row.date === b.row.date ? a.index - b.index : a.row.date < b.row.date ? -1 : 1,
    );
  for (let start = 0; start < debits.length;) {
    let end = start;
    while (end < debits.length && debits[end]!.row.date === debits[start]!.row.date) end += 1;
    const pending = debits.slice(start, end).map((one) => one.index);
    for (let settling = true; settling;) {
      settling = false;
      for (const index of pending) {
        const won = clear(index);
        if (won === undefined) continue;
        found.set(index, [won.candidate]);
        settled[won.at] = won.next;
        pending.splice(pending.indexOf(index), 1);
        settling = true;
        break;
      }
    }
    for (const index of pending) {
      const left = offers(index).map((one) => one.candidate);
      if (left.length > 0) found.set(index, left);
    }
    start = end;
  }
  return found;
};

const TRANSFER =
  /\bself\b|own a\/?c|own account|to own|from own|sweep|\bfd\b|fixed deposit|credit card payment|\bcc (payment|pymt)|card payment|payment received|thank you|autopay|bill ?desk.*card/i;
const CHARGES =
  /chgs|charges|\bfees?\b|annual fee|gst on|sms chg|min(imum)? bal|cash handling|commission|penalty/i;
const TAX =
  /\bcbdt\b|\btds\b|\bgst ?(pmt|payment|challan)|\bgstn\b|advance tax|challan|income tax|\bitns\b/i;
const SALARY = /salary|salaries|\bsal\b|payroll|wages|stipend/i;
const DRAWINGS = /drawings?|reimburse/i;
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

/** Who a narration paid, from the way banks write card lines and every region's payment rails. */
export const SALARIES = "salaries";
const CHANNEL_WORDS = [
  ...RAILS,
  "pos",
  "atm",
  "inb",
  "ib",
  "mb",
  "bil",
  "billpay",
  "dr",
  "cr",
  "to",
  "by",
  "trf",
  "transfer",
  "purchase",
  "txn",
  "salary",
  "sal",
];
const CHANNEL = new RegExp(String.raw`^(?:${CHANNEL_WORDS.join("|")})\b[\s\-/:.]*`, "i");
/** A payee's name without the bank's words before it: channel, direction and reference numbers. */
const payee = (text: string) => {
  let rest = text.trim();
  for (let left = 8; left > 0; left -= 1) {
    const next = rest.replace(CHANNEL, "").replace(/^[\d\s\-/:.]+(?=\D)/, "");
    if (next === rest) break;
    rest = next;
  }
  return rest;
};
/** The bank's own prose, such as "BEING AMOUNT PAID TOWARDS …": it names nobody. */
const BANK_PROSE = /^(?:being|towards|chq|cheque)\b/i;
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
  const named = payee(found ?? "");
  if (BANK_PROSE.test(named)) return undefined;
  const cleaned = named
    .replace(/\b(USD|EUR|GBP|SGD|AED|AUD|CAD)\s?[\d,.]+/gi, "")
    .replace(/\*.*$/, "")
    .replace(/\.(com|in|io|co)\b.*$/i, "")
    .replace(/@\S+/g, "")
    .replace(/[\d,.]{4,}/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
  if (cleaned.length < 2 || notAVendor(cleaned)) return undefined;
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
  if (DRAWINGS.test(text)) return { action: "ignore", why: "Drawings or a reimbursement" };
  const guessed = vendorOf(text);
  if (SALARY.test(text))
    return {
      action: "expense",
      ...(guessed === undefined ? {} : { vendor: guessed }),
      category: SALARIES,
      why: "A salary",
    };
  const known = input.known
    .filter((one) => !notAVendor(one.vendor))
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

/**
 * Money in that nothing matched and that isn't a transfer, interest or a refund: the open
 * invoices it could pay, for the owner to choose. Never proposed, so never ticked.
 */
const openInvoices = (
  row: StatementRow,
  input: Parameters<typeof suggest>[1] & {
    readonly currency: string;
    readonly invoices: ReadonlyArray<InvoiceCandidate>;
  },
): ReadonlyArray<Candidate> => {
  if (row.direction !== "credit" || suggest(row, input).action !== "later") return [];
  return input.invoices
    .filter(
      (invoice) =>
        invoice.currency === input.currency &&
        (invoice.issued === null || daysBetween(invoice.issued, row.date) >= 0) &&
        invoice.amountMinor - invoice.paidMinor >= row.amountMinor,
    )
    .map((invoice): Candidate => {
      const named = invoice.client === null ? 0 : nameIn(invoice.client, row.description);
      return {
        kind: "invoice",
        recordId: invoice.recordId,
        key: invoice.key,
        title: invoice.title,
        fit: "open",
        seen: invoice.seen,
        score: Math.round(20 * named),
        why: ["an open invoice"],
      };
    })
    .toSorted((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    .slice(0, 5);
};

/** Each row's candidates, best first, and whether one is clear enough to propose on its own. */
export const matchRows = (
  rows: ReadonlyArray<StatementRow>,
  input: {
    readonly currency: string;
    /** The company's country withholds tax at source: a short credit may be a TDS cut. */
    readonly withholdsAtSource: boolean;
    readonly invoices: ReadonlyArray<InvoiceCandidate>;
    readonly payments?: ReadonlyArray<PaymentCandidate>;
    readonly expenses: ReadonlyArray<ExpenseCandidate>;
    /** Partners owed back; a debit to one repays their oldest expenses. */
    readonly partners?: ReadonlyArray<PartnerCandidate>;
    /** Everyone who has funded an expense: a line naming one is theirs to place, not a new expense. */
    readonly payees?: ReadonlyArray<PayeeCandidate>;
    readonly ownAccounts: ReadonlyArray<string>;
    readonly known: ReadonlyArray<KnownVendor>;
    readonly bank: string | null;
  },
): ReadonlyArray<RowMatch> => {
  const taken = new Set<string>();
  const others = rows.map((row) =>
    (row.direction === "credit"
      ? [
          ...input.invoices.map((invoice) =>
            invoiceCandidate(row, invoice, input.currency, input.withholdsAtSource),
          ),
          ...(input.payments ?? []).map((payment) =>
            paymentCandidate(row, payment, input.currency),
          ),
          ...input.expenses.map((expense) =>
            expenseCandidate(
              row,
              expense,
              input.currency,
              suggest(row, input).action === "transfer",
            ),
          ),
        ]
      : input.expenses.map((expense) => expenseCandidate(row, expense, input.currency))
    ).filter((one): one is Candidate => one !== undefined && one.score >= PROPOSED),
  );
  const named = (row: StatementRow) => (one: Pick<PartnerCandidate, "name" | "ids">) =>
    identifies(one, row.description) || personIn(one.name, row.description) >= 0.5;
  /** A repayment to someone this line names, marked by hand with no bank row: likely this one. */
  const markedFor = (row: StatementRow) => {
    const signed = BigInt(row.direction === "debit" ? row.amountMinor : -row.amountMinor);
    for (const payee of (input.payees ?? []).filter(named(row))) {
      const marked = payee.repaid.find(
        (one) =>
          one.currency === input.currency &&
          BigInt(one.amountMinor) === signed &&
          Math.abs(daysBetween(one.day, row.date)) <= 10,
      );
      if (marked !== undefined) return { name: payee.name, day: marked.day };
    }
    return undefined;
  };
  // A move between the company's own accounts that names a partner repays nobody, and a
  // repayment already marked by hand isn't offered again.
  const skipped = rows.map(
    (row) => suggest(row, input).action === "transfer" || markedFor(row) !== undefined,
  );
  const repaying = repayments(
    rows,
    input.partners ?? [],
    input.currency,
    (index) => others[index]!,
    (index) => skipped[index]!,
  );
  const results = rows.map((row, index) => {
    const candidates = [...(repaying.get(index) ?? []), ...others[index]!]
      .toSorted((left, right) => right.score - left.score || left.key.localeCompare(right.key))
      .slice(0, 5);
    return {
      row,
      candidates: candidates.length > 0 ? candidates : openInvoices(row, input),
    };
  });
  // One entry answers one row: the clearest claim keeps it, and the others see it as taken.
  const order = results
    .flatMap((result, index) =>
      result.candidates[0] === undefined ? [] : [{ index, score: result.candidates[0].score }],
    )
    .toSorted((left, right) => right.score - left.score || left.index - right.index);
  // A line naming a partner it settles nothing for is the owner's to place, never a new expense.
  const suggestFor = (row: StatementRow): Suggestion => {
    const plain = suggest(row, input);
    if (plain.action === "transfer") return plain;
    const marked = markedFor(row);
    if (marked !== undefined)
      return {
        action: "later",
        why: `Looks like ${marked.name}'s repayment already marked on ${marked.day}, so it isn't recorded again`,
      };
    const partner = (input.partners ?? []).find(
      (one) => one.currency === input.currency && one.owed.length > 0 && named(row)(one),
    );
    if (partner !== undefined) {
      // Part repayments aren't tracked: marking them repaid would settle more than was paid.
      const owed = partner.owed.reduce((sum, one) => sum + BigInt(one.amountMinor), 0n);
      return {
        action: "later",
        why: `This doesn't match what ${partner.name} is owed (${formatMinor(owed, partner.currency)}). Kin settles a repayment only when it matches.`,
      };
    }
    const payee = [...(input.partners ?? []), ...(input.payees ?? [])].find(named(row));
    if (payee === undefined) return plain;
    return {
      action: "later",
      why: `It names ${payee.name}, who is owed nothing in ${input.currency}, so it isn't offered as a new expense`,
    };
  };
  const settled = new Map<number, RowMatch>();
  for (const { index } of order) {
    const { row, candidates } = results[index]!;
    const claims = (one: Candidate) => one.repays?.map((each) => each.recordId) ?? [one.recordId];
    const open = candidates.filter((one) => !claims(one).some((id) => taken.has(id)));
    const [best, next] = open;
    const clear =
      best !== undefined &&
      best.score >= CONFIDENT &&
      (next === undefined || best.score - next.score >= MARGIN);
    if (clear) for (const id of claims(best)) taken.add(id);
    settled.set(index, {
      group: clear ? "matched" : open.length > 0 ? "choose" : "unmatched",
      candidates: clear ? [best] : open,
      suggestion: suggestFor(row),
    });
  }
  return results.map(
    ({ row }, index) =>
      settled.get(index) ?? { group: "unmatched", candidates: [], suggestion: suggestFor(row) },
  );
};
