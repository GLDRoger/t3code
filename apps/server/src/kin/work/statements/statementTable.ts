import * as Schema from "effect/Schema";

import { currencyDigits, formatMoney, isCurrency } from "../money.ts";
import {
  bankIn,
  type DateOrder,
  dateOrderIn,
  likelyCurrencies,
  regionNamedIn,
} from "./statementRegion.ts";

/**
 * A bank or card statement read from its table: whatever the file was, it arrives here as lines
 * of cells, with x positions when it came from a PDF page. Columns are found from the header's
 * words, not from any one bank's layout, and the totals are checked against the balances given.
 */

export type Cell = {
  readonly text: string;
  /** Left and right edges on the page, for PDF lines; absent for spreadsheet and CSV cells. */
  readonly x?: number;
  readonly right?: number;
  /** A spreadsheet's own number, kept so a date stored as a serial reads as that date. */
  readonly serial?: number;
};
export type Line = ReadonlyArray<Cell>;

export type Direction = "debit" | "credit";
export type StatementRow = {
  /** Its place in the statement, from 0: two identical rows on one day stay two. */
  readonly index: number;
  readonly date: string;
  readonly description: string;
  readonly reference: string | null;
  readonly amountMinor: number;
  readonly direction: Direction;
  readonly balanceMinor: number | null;
  /** A card's foreign spend as the narration gives it: the amount charged in that currency. */
  readonly foreign: { readonly currency: string; readonly amountMinor: number } | null;
};
export type BalanceCheck =
  | { readonly status: "adds_up"; readonly line: string }
  | { readonly status: "off"; readonly line: string }
  | { readonly status: "unchecked"; readonly line: string };
export type Statement = {
  readonly kind: "account" | "card";
  readonly bank: string | null;
  /** The account's or card's last four digits, when the statement states them. */
  readonly account: string | null;
  /** The full number the file prints, only as the reader returns it; never kept (`accountId`). */
  readonly accountNumber?: string | null;
  /**
   * The account's keyed identity from its full number and bank; null when the file doesn't print
   * both. Absent on a statement first read before identities: its rows go by `account` alone.
   */
  readonly accountId?: string | null;
  readonly currency: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly openingMinor: number | null;
  readonly closingMinor: number | null;
  readonly rows: ReadonlyArray<StatementRow>;
  readonly check: BalanceCheck;
  /** The file doesn't prove its currency: read in `currency`, the owner picks one of these. */
  readonly currencyChoice?: ReadonlyArray<string>;
  /** How its numeric dates were read; absent on one read before this was kept, read day first. */
  readonly dateOrder?: DateOrder;
};
export type StatementFacts = Omit<
  Statement,
  "rows" | "check" | "currency" | "currencyChoice" | "dateOrder"
>;

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Whether a sum of minor units is still a number Kin keeps exactly. */
export const isExact = (value: bigint) => value <= SAFE && value >= -SAFE;
export const TOO_LARGE =
  "Its figures run past what Kin can add up exactly, so Kin couldn't check them. Send a shorter period.";
export type TableResult =
  | { readonly _tag: "read"; readonly statement: Statement }
  | { readonly _tag: "no_table"; readonly reason: string };

type Role =
  | "date"
  | "valueDate"
  | "description"
  | "reference"
  | "debit"
  | "credit"
  | "amount"
  | "drcr"
  | "balance";

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** What a header cell names. Order matters: "Value Dt" is not the date, "Debit/Credit" not a debit. */
const roleOf = (text: string): Role | undefined => {
  const said = words(text);
  if (said === "" || said.length > 40) return undefined;
  if (/\bbal(ance)?\b/.test(said)) return "balance";
  if (/^value (dt|date)\b/.test(said)) return "valueDate";
  if (/^(dr cr|cr dr|debit credit|credit debit|type|txn type|transaction type)$/.test(said))
    return "drcr";
  if (/withdrawal|\bdebit|^dr$|paid out|^debits?\b/.test(said)) return "debit";
  if (/deposit|\bcredit|^cr$|paid in/.test(said)) return "credit";
  if (/narration|description|particular|detail|remark/.test(said)) return "description";
  if (/\b(chq|cheque|ref|reference|utr|instrument)\b|transaction id|txn id/.test(said))
    return "reference";
  if (/\bdate\b|^txn dt$|^dt$/.test(said)) return "date";
  if (/\b(amount|amt)\b/.test(said)) return "amount";
  return undefined;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (value: number) => String(value).padStart(2, "0");
const fullYear = (year: number) => (year < 100 ? 2000 + year : year);
const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysIn = (year: number, month: number) =>
  month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
const validDay = (year: number, month: number, day: number) =>
  month < 1 || month > 12 || day < 1 || year < 1990 || year > 2200 || day > daysIn(year, month)
    ? undefined
    : `${year}-${pad(month)}-${pad(day)}`;

/** A spreadsheet day serial (1900 system, day 25569 is 1970-01-01) as a day. */
const fromSerial = (serial: number) => {
  if (!(serial > 30_000 && serial < 80_000)) return undefined;
  // Days since 1970 to a civil date (Howard Hinnant's algorithm).
  const z = Math.floor(serial) - 25_569 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return validDay(yoe + era * 400 + (month <= 2 ? 1 : 0), month, day);
};

/**
 * A statement's date in `order` when it is all numbers ("03/04/2026"), or ISO, or with its month
 * named; a time after it is ignored. `statementDateOrder` says which order a statement uses.
 */
export const parseDay = (text: string, order: DateOrder, serial?: number): string | undefined => {
  if (serial !== undefined) return fromSerial(serial);
  const said = text.trim().replace(/\s+/g, " ");
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s|,])/.exec(said);
  if (iso !== null) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:$|[\s|,T])/.exec(said);
  if (numeric !== null) {
    const [first, second] = [Number(numeric[1]), Number(numeric[2])];
    return order === "dmy"
      ? validDay(fullYear(Number(numeric[3])), second, first)
      : validDay(fullYear(Number(numeric[3])), first, second);
  }
  const named =
    /^(\d{1,2})(?:st|nd|rd|th)?[\s/.-]?([A-Za-z]{3,9})[\s/.,-]*(\d{4}|\d{2})(?:$|[\s|,T])/.exec(
      said,
    );
  if (named !== null) {
    const month = MONTHS.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1;
    return month === 0 ? undefined : validDay(fullYear(Number(named[3])), month, Number(named[1]));
  }
  const monthFirst = /^([A-Za-z]{3,9})\s(\d{1,2}),?\s(\d{4})(?:$|[\s|,T])/.exec(said);
  if (monthFirst !== null) {
    const month = MONTHS.indexOf(monthFirst[1]!.slice(0, 3).toLowerCase()) + 1;
    return month === 0 ? undefined : validDay(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }
  return undefined;
};

/** Whether a line starts with a date in either order: a row, not a narration's next line. */
export const isDated = (text: string) =>
  parseDay(text, "dmy") !== undefined || parseDay(text, "mdy") !== undefined;

export type ParsedAmount = {
  readonly minor: number;
  readonly negative: boolean;
  readonly marker: Direction | null;
};
const AMOUNT =
  /^(?<pre>[+-]|\()?\s*(?:₹|rs\.?|inr|[$€£¥]|c)?\s*(?<sign>[+-])?\s*(?<num>\d{1,3}(?:,\d{2,3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)\s*(?<post>\)|-)?\s*(?<mark>cr|dr|c|d)?\.?$/i;

/**
 * An amount as statements print it, in minor units of a currency with `digits` of them:
 * "1,23,456.78", "(500.00)", "1,200.00 Cr", "-45", "₹ 99"; "1,500" in yen.
 */
export const parseAmount = (text: string, digits = 2): ParsedAmount | undefined => {
  const said = text.trim().replace(/ /g, " ");
  if (said === "" || said.length > 40) return undefined;
  const found = AMOUNT.exec(said);
  if (found?.groups === undefined) return undefined;
  const { pre, sign, num, post, mark } = found.groups;
  const [whole, fraction = ""] = num!.replace(/,/g, "").split(".");
  if (fraction.length > digits && !/^0*$/.test(fraction.slice(digits))) return undefined;
  const minor =
    Number(whole) * 10 ** digits + Number(fraction.slice(0, digits).padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) return undefined;
  const marker = mark === undefined ? null : /^c/i.test(mark) ? "credit" : "debit";
  return {
    minor,
    negative: pre === "-" || pre === "(" || sign === "-" || post === "-" || post === ")",
    marker: pre === "+" || sign === "+" ? "credit" : marker,
  };
};
const SHAPES = [0, 1, 2, 3, 4].map((digits) =>
  digits === 0 ? /\d,\d{3}/ : new RegExp(String.raw`\d[.,]\d{${digits}}\b|\d,\d{3}`),
);
/** Only something printed as money: with paise or grouping, so a cheque number never reads as one. */
export const looksLikeMoney = (text: string, digits = 2) =>
  (SHAPES[digits] ?? SHAPES[2]!).test(text) && parseAmount(text, digits) !== undefined;

/** The line naming a date, the narration and an amount: the columns the rows sit under. */
export const isHeaderLine = (line: string) =>
  /\bdate\b/i.test(line) &&
  /narration|description|particular|detail/i.test(line) &&
  /withdrawal|debit|deposit|credit|amount/i.test(line);

const UNAMBIGUOUS: ReadonlyArray<readonly [RegExp, string]> = [
  // oxlint-disable-next-line t3code/kin-one-format -- the rupee sign names the rupee, whatever the home.
  [/₹/u, "INR"],
  [/€/u, "EUR"],
  [/£/u, "GBP"],
];
/** Symbols more than one currency prints: evidence of the family, never of one of them. */
const AMBIGUOUS: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [
  [/(?<![A-Z])\$/u, ["USD", "SGD", "AUD", "CAD", "HKD", "NZD"]],
  [/¥/u, ["JPY", "CNY"]],
];
const LABELLED = /\bcurrency(?:\s+code)?\s*[:-]?\s*([A-Za-z]{3})\b/gi;
const NAMED =
  /\((?:in\s+)?([A-Z]{3})\)|\bin\s+([A-Z]{3})\b|\b([A-Z]{3})\s+[-(]?\d[\d,]*\.\d|\d\.\d+\)?\s+([A-Z]{3})\b/g;
const SUMMARY = /opening|closing|balance|total|summary/i;
export type CurrencyRead =
  | { readonly currency: string; readonly choose?: ReadonlyArray<string> }
  | { readonly refused: string };

/**
 * A statement's currency from its labels, header and summary lines (never narration), else the
 * country its bank or account markers name. Unproven or conflicting, it reads in the likeliest one,
 * the company's `home` first, and `choose` lists same-minor-unit picks for the owner, so a pick
 * only relabels. Refused when not recordable.
 */
export const currencyIn = (text: string, home: string, proposed?: string): CurrencyRead => {
  const common = likelyCurrencies(home);
  const recordable = (code: string) => isCurrency(code) && currencyDigits(code) <= 4;
  const found = new Set<string>();
  const families: Array<ReadonlyArray<string>> = [];
  for (const match of text.matchAll(LABELLED)) found.add(match[1]!.toUpperCase());
  for (const line of text.split("\n")) {
    // A summary line, not a row of the table, which starts with its date.
    const summary = SUMMARY.test(line) && !isDated(line.trimStart());
    if (!isHeaderLine(line) && !summary) continue;
    for (const match of line.matchAll(NAMED)) {
      const code = match.slice(1).find((one) => one !== undefined)!;
      if (isCurrency(code)) found.add(code);
    }
    for (const [symbol, code] of UNAMBIGUOUS) if (symbol.test(line)) found.add(code);
    for (const [symbol, codes] of AMBIGUOUS) if (symbol.test(line)) families.push(codes);
  }
  const fitting = families.filter((codes) => ![...found].some((code) => codes.includes(code)));
  if (found.size === 1 && fitting.length === 0) {
    const code = [...found][0]!;
    return recordable(code)
      ? { currency: code }
      : {
          refused: `The statement's amounts are in ${code.slice(0, 3)}, which Kin can't record exactly.`,
        };
  }
  const named = found.size === 0 && fitting.length === 0 ? regionNamedIn(text) : undefined;
  if (named !== undefined) return { currency: named.currency };
  const candidates = [
    ...new Set(
      (found.size > 0 ? [...found] : fitting.length > 0 ? fitting.flat() : common).filter(
        recordable,
      ),
    ),
  ];
  const asked = proposed?.toUpperCase();
  const suggested =
    asked !== undefined && recordable(asked) && (candidates.includes(asked) || found.size === 0)
      ? asked
      : (candidates.find((code) => code === home) ?? candidates[0] ?? home);
  const choose = [suggested, ...candidates, ...(found.size === 0 ? common : [])].filter(
    (code, at, all) =>
      all.indexOf(code) === at && currencyDigits(code) === currencyDigits(suggested),
  );
  return { currency: suggested, choose };
};

const ACCOUNT =
  /(?:account|a\/c|acct)\s*(?:no|number|num)?\.?\s*[:-]?\s*([0-9Xx*•\s-]{4,30}\d{4})(?!\d)/i;
const CARD =
  /\bcard\s*(?:no|number|num)?\.?\s*[:-]?\s*((?:\d{4}|[Xx*•]{4})[\s-]?(?:[\dXx*•]{2,6}[\s-]?){1,3}\d{4})(?!\d)/i;
const DATE_TEXT = String.raw`(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}[\s-]?[A-Za-z]{3,9}[\s,-]*\d{2,4}|\d{4}-\d{2}-\d{2})`;
const PERIOD = new RegExp(
  String.raw`(?:from|period|statement\s+(?:for|of)?)\s*:?\s*${DATE_TEXT}\s*(?:to|-|–|till|until)\s*:?\s*${DATE_TEXT}`,
  "i",
);
export const FOREIGN =
  /\b(USD|EUR|GBP|SGD|AED|AUD|CAD|JPY|CHF|HKD|NZD|SEK|THB|MYR|CNY|ZAR|SAR|QAR)\s?([\d,]+(?:\.\d{1,2})?)\b|\b([\d,]+\.\d{2})\s?(USD|EUR|GBP|SGD|AED|AUD|CAD|JPY|CHF|HKD|NZD|SEK|THB|MYR|CNY|ZAR|SAR|QAR)\b/;

const lineText = (line: Line) => line.map((cell) => cell.text.trim()).join(" ");

type Header = {
  readonly at: number;
  readonly columns: ReadonlyArray<{
    readonly role: Role;
    readonly index: number;
    readonly x?: number;
    readonly right?: number;
  }>;
};

/** The line that heads the table: it names a date, what happened and at least one amount. */
const findHeader = (lines: ReadonlyArray<Line>): Header | undefined => {
  for (let at = 0; at < lines.length; at += 1) {
    const cells = mergeHeaderCells(lines[at]!);
    const columns = cells.flatMap((cell, index) => {
      const role = roleOf(cell.text);
      return role === undefined
        ? []
        : [
            {
              role,
              index,
              ...(cell.x === undefined ? {} : { x: cell.x }),
              ...(cell.right === undefined ? {} : { right: cell.right }),
            },
          ];
    });
    const has = (role: Role) => columns.some((column) => column.role === role);
    if (has("date") && has("description") && (has("debit") || has("credit") || has("amount")))
      return { at, columns: firstOfEach(columns) };
  }
  return undefined;
};
const CURRENCY_COLUMN = /^(currency|currency code|ccy|curr)$/;
const ACCOUNT_COLUMN = /^(account|account no|account number|acct|acct no|a c|a c no|account id)$/;
/**
 * A spreadsheet's or CSV's own Currency and Account columns, where every dated row says the same
 * one. A PDF's cells sit by position, so its columns are never read this way.
 */
export const columnFacts = (lines: ReadonlyArray<Line>) => {
  const header = findHeader(lines);
  const cells = header === undefined ? undefined : lines[header.at]!;
  const date = header?.columns.find((column) => column.role === "date");
  if (header === undefined || cells === undefined || date === undefined || date.x !== undefined)
    return { currency: null, account: null };
  const rows = lines.slice(header.at + 1).filter((line) => {
    const cell = line[date.index];
    return cell !== undefined && parseDay(cell.text, "dmy", cell.serial) !== undefined;
  });
  const said = (column: RegExp) => {
    const index = cells.findIndex((cell) => column.test(words(cell.text)));
    if (index < 0) return null;
    const values = new Set(rows.map((line) => line[index]?.text.trim() ?? ""));
    const [one] = values;
    return values.size === 1 && one !== undefined && one !== "" ? one : null;
  };
  const code = said(CURRENCY_COLUMN)?.toUpperCase() ?? null;
  const number = said(ACCOUNT_COLUMN);
  const digits = number?.replace(/\D/g, "") ?? "";
  return {
    currency: code !== null && isCurrency(code) ? code : null,
    account:
      number === null || digits.length < 4
        ? null
        : {
            digits: digits.slice(-4),
            number: /[Xx*•]/.test(number) || digits.length < 8 ? null : digits,
          },
  };
};
const firstOfEach = <C extends { readonly role: Role }>(columns: ReadonlyArray<C>) =>
  columns.filter((column, index) => columns.findIndex((one) => one.role === column.role) === index);

/** A PDF header split into words ("Withdrawal" "Amt.") reads as the one label it is. */
const mergeHeaderCells = (line: Line): Line => {
  if (line.every((cell) => cell.x === undefined)) return line;
  const merged: Array<Cell> = [];
  for (const cell of line) {
    const last = merged.at(-1);
    const joined = last === undefined ? undefined : `${last.text} ${cell.text}`;
    if (
      last !== undefined &&
      joined !== undefined &&
      cell.x !== undefined &&
      last.right !== undefined &&
      cell.x - last.right < 12 &&
      (roleOf(cell.text) === undefined || roleOf(last.text) === undefined) &&
      roleOf(joined) !== undefined
    ) {
      merged[merged.length - 1] = { text: joined, x: last.x!, right: cell.right ?? cell.x };
      continue;
    }
    merged.push(cell);
  }
  return merged;
};

const NUMERIC_ROLES = new Set<Role>(["debit", "credit", "amount", "balance"]);

/** A PDF line's cells by the header's columns: money by right edge, words by where they start. */
const placeCells = (line: Line, header: Header, digits: number): Map<Role, Array<Cell>> => {
  const placed = new Map<Role, Array<Cell>>();
  const put = (role: Role, cell: Cell) => {
    const cells = placed.get(role);
    if (cells === undefined) placed.set(role, [cell]);
    else cells.push(cell);
  };
  const positioned = header.columns.filter((column) => column.x !== undefined);
  if (positioned.length === 0) {
    for (const column of header.columns) {
      const cell = line[column.index];
      if (cell !== undefined && cell.text.trim() !== "") put(column.role, cell);
    }
    return placed;
  }
  const byLeft = positioned.toSorted((left, right) => left.x! - right.x!);
  for (const [index, cell] of line.entries()) {
    if (cell.x === undefined || cell.text.trim() === "") continue;
    const marker = /^(cr|dr)\.?$/i.test(cell.text.trim());
    if (marker) {
      // A "Cr" printed beside an amount belongs to it.
      const before = line
        .slice(0, index)
        .findLast((one) => looksLikeMoney(one.text, digits) && one.x !== undefined);
      if (before !== undefined) {
        put("drcr", cell);
        continue;
      }
    }
    // A bare integer is money only right under a money column, as a yen amount is; never a
    // cheque number.
    const whole = /^\d{1,15}$/.test(cell.text.trim());
    if (whole || looksLikeMoney(cell.text, digits)) {
      const right = cell.right ?? cell.x;
      const center = (cell.x + right) / 2;
      const numeric = byLeft.filter((column) => NUMERIC_ROLES.has(column.role));
      const nearest = numeric.toSorted(
        (left, other) => distance(left, right, center) - distance(other, right, center),
      )[0];
      if (nearest !== undefined && distance(nearest, right, center) < (whole ? 12 : 160)) {
        put(nearest.role, cell);
        continue;
      }
    }
    const words = whole ? byLeft.filter((one) => !NUMERIC_ROLES.has(one.role)) : byLeft;
    const column = words.findLast((one) => one.x! <= cell.x! + 4) ?? words[0] ?? byLeft[0]!;
    put(column.role, cell);
  }
  return placed;
};
const distance = (
  column: { readonly x?: number; readonly right?: number },
  right: number,
  center: number,
) => {
  const columnRight = column.right ?? column.x!;
  const columnCenter = (column.x! + columnRight) / 2;
  return Math.min(Math.abs(columnRight - right), Math.abs(columnCenter - center));
};

const joined = (cells: ReadonlyArray<Cell> | undefined) =>
  (cells ?? [])
    .map((cell) => cell.text.trim())
    .filter((text) => text !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
const firstAmount = (cells: ReadonlyArray<Cell> | undefined, digits: number) => {
  for (const cell of cells ?? []) {
    const amount = parseAmount(cell.text, digits);
    if (amount !== undefined) return amount;
  }
  return undefined;
};

export const END_OF_TABLE =
  /statement summary|^\s*\*+\s*end of statement|opening balance.*closing bal|^total\b|^grand total|closing balance includes/i;

type Draft = {
  date: string;
  description: string;
  reference: string | null;
  amountMinor: number;
  direction: Direction | null;
  negative: boolean;
  marker: Direction | null;
  balanceMinor: number | null;
};

/** How a statement reads: its currency, and the date order its region uses when it doesn't show one. */
export interface StatementReading {
  readonly currency: string;
  readonly dateOrder: DateOrder;
}

/** The facts around the table: the account, the bank, the period and the stated balances. */
export const readFacts = (lines: ReadonlyArray<Line>, reading: StatementReading) => {
  const { currency } = reading;
  const text = lines.map(lineText).join("\n");
  const card = CARD.exec(text);
  const account = ACCOUNT.exec(text);
  const digits = (found: RegExpExecArray | null) =>
    found === null ? null : (/(\d{4})\D*$/.exec(found[1]!)?.[1] ?? null);
  // Printed whole, unmasked: what tells two accounts with the same last four digits apart.
  const whole = (found: RegExpExecArray | null) => {
    const number = found === null || /[Xx*•]/.test(found[1]!) ? "" : found[1]!.replace(/\D/g, "");
    return number.length >= 8 ? number : null;
  };
  const period = PERIOD.exec(text);
  const bank = bankIn(text)?.name ?? null;
  const order =
    period === null ? reading.dateOrder : dateOrderIn([period[1]!, period[2]!], reading.dateOrder);
  const isCard =
    /credit card|card statement|total (amount )?dues?|minimum (amount )?due/i.test(text) &&
    card !== null;
  // The file's own Account column says which account it is, whatever its text matched.
  const column = isCard ? null : columnFacts(lines).account;
  const printed = account !== null ? whole(account) : whole(card);
  return {
    kind: isCard ? ("card" as const) : ("account" as const),
    bank,
    account: isCard ? digits(card) : (column?.digits ?? digits(account) ?? digits(card)),
    accountNumber: isCard
      ? whole(card)
      : column === null
        ? printed
        : (column.number ?? (printed?.endsWith(column.digits) === true ? printed : null)),
    from: period === null ? null : (parseDay(period[1]!, order) ?? null),
    to: period === null ? null : (parseDay(period[2]!, order) ?? null),
    ...statedBalances(lines, currencyDigits(currency)),
  };
};

const OPENING = /^(opening|previous|last statement)\s*(bal|balance|statement balance|dues?)\b/;
const CLOSING = /^(closing|total)\s*(bal|balance|dues?|amount due)\b|^total amount due\b/;

/**
 * Opening and closing balances, written beside their label ("Opening Balance : 1,000.00") or
 * as a summary row of labels with the figures on the line under it.
 */
const statedBalances = (lines: ReadonlyArray<Line>, digits: number) => {
  const stated = new RegExp(
    String.raw`(opening balance|previous balance|closing balance|closing bal|total dues|total amount due)\s*[:-]?\s*(?:[a-z]{3}\s+)?((?:₹|rs\.?|inr|[$€£¥])?\s*-?[\d,]+${digits === 0 ? "" : String.raw`\.\d{${digits}}`}\s*(?:cr|dr)?)`,
    "gi",
  );
  let openingMinor: number | null = null;
  let closingMinor: number | null = null;
  const set = (label: string, amount: ParsedAmount | undefined) => {
    if (amount === undefined) return;
    const signed = amount.negative || amount.marker === "debit" ? -amount.minor : amount.minor;
    if (openingMinor === null && OPENING.test(label)) openingMinor = signed;
    else if (closingMinor === null && CLOSING.test(label)) closingMinor = signed;
  };
  for (const [at, line] of lines.entries()) {
    const text = lineText(line);
    for (const found of text.matchAll(stated))
      set(words(found[1]!), parseAmount(found[2]!, digits));
    const labels = line.flatMap((cell, index) => {
      const said = words(cell.text);
      return OPENING.test(said) || CLOSING.test(said) ? [{ said, index, cell }] : [];
    });
    if (labels.length === 0 || /\d[.,]\d{2}/.test(text) || findHeader([line]) !== undefined)
      continue;
    const next = lines[at + 1];
    if (next === undefined) continue;
    const figures = next.filter((cell) => parseAmount(cell.text, digits) !== undefined);
    for (const label of labels) {
      const figure =
        label.cell.x === undefined
          ? next[label.index]
          : figures.toSorted(
              (left, right) =>
                Math.abs(centerOf(left) - centerOf(label.cell)) -
                Math.abs(centerOf(right) - centerOf(label.cell)),
            )[0];
      set(label.said, figure === undefined ? undefined : parseAmount(figure.text, digits));
    }
  }
  return { openingMinor, closingMinor };
};
const centerOf = (cell: Cell) => ((cell.x ?? 0) + (cell.right ?? cell.x ?? 0)) / 2;

/** Every transaction in the table, multi-line narrations joined, repeated page headers skipped. */
export const readTable = (lines: ReadonlyArray<Line>, given: StatementReading): TableResult => {
  const { currency } = given;
  const digits = currencyDigits(currency);
  const header = findHeader(lines);
  if (header === undefined)
    return {
      _tag: "no_table",
      reason: "Kin found no table with a date, a description and an amount column in this file.",
    };
  // The statement's own dates decide their order where any can only be read one way.
  const dateCells = lines
    .slice(header.at + 1)
    .flatMap((line) => placeCells(line, header, digits).get("date")?.slice(0, 1) ?? []);
  const reading = {
    currency,
    dateOrder: dateOrderIn(
      dateCells.map((cell) => cell.text),
      given.dateOrder,
    ),
  };
  const facts = readFacts(lines, reading);
  const drafts: Array<Draft> = [];
  let ended = false;
  for (const line of lines.slice(header.at + 1)) {
    const text = lineText(line);
    if (text.trim() === "") continue;
    if (END_OF_TABLE.test(text.trim())) {
      ended = drafts.length > 0;
      continue;
    }
    const cells = placeCells(line, header, digits);
    const dateCell = cells.get("date")?.[0];
    const date =
      dateCell === undefined
        ? undefined
        : parseDay(dateCell.text, reading.dateOrder, dateCell.serial);
    if (date === undefined) {
      // A repeated header on the next page, or the next line of the row above's narration.
      if (findHeader([line]) !== undefined) {
        ended = false;
        continue;
      }
      const last = drafts.at(-1);
      const more = joined(cells.get("description"));
      const money = [...cells.entries()].some(
        ([role, found]) => NUMERIC_ROLES.has(role) && found.length > 0,
      );
      if (last !== undefined && !ended && more !== "" && !money && last.description.length < 2_000)
        last.description = `${last.description} ${more}`.trim();
      if (last !== undefined && !ended && last.reference === null) {
        const reference = joined(cells.get("reference"));
        if (reference !== "" && !money) last.reference = reference;
      }
      continue;
    }
    if (ended) continue;
    const debit = firstAmount(cells.get("debit"), digits);
    const credit = firstAmount(cells.get("credit"), digits);
    const amount = firstAmount(cells.get("amount"), digits);
    const balance = firstAmount(cells.get("balance"), digits);
    const drcr = words(joined(cells.get("drcr")));
    const marked: Direction | null = /^(cr|c|credit|deposit)/.test(drcr)
      ? "credit"
      : /^(dr|d|debit|withdrawal)/.test(drcr)
        ? "debit"
        : null;
    const chosen =
      debit !== undefined && debit.minor > 0
        ? { amount: debit, direction: "debit" as Direction | null }
        : credit !== undefined && credit.minor > 0
          ? { amount: credit, direction: "credit" as Direction | null }
          : amount !== undefined && amount.minor > 0
            ? { amount, direction: marked ?? amount.marker }
            : undefined;
    if (chosen === undefined) continue;
    drafts.push({
      date,
      description: joined(cells.get("description")),
      reference: joined(cells.get("reference")) || null,
      amountMinor: chosen.amount.minor,
      direction: chosen.direction,
      negative: chosen.amount.negative,
      marker: chosen.amount.marker,
      balanceMinor:
        balance === undefined
          ? null
          : balance.negative || balance.marker === "debit"
            ? -balance.minor
            : balance.minor,
    });
  }
  if (drafts.length === 0)
    return { _tag: "no_table", reason: "Kin found the table's columns but no transactions in it." };
  const rows = settleDirections(drafts, facts.kind, facts.openingMinor);
  return {
    _tag: "read",
    statement: {
      ...facts,
      currency,
      dateOrder: reading.dateOrder,
      rows,
      check: checkBalances(facts.kind, rows, facts.openingMinor, facts.closingMinor, currency),
    },
  };
};

/**
 * Which way each row went. A debit or credit column says it; a single amount column goes by its
 * Cr/Dr mark or sign, and where running balances are given, by which way the balance moved.
 */
const settleDirections = (
  drafts: ReadonlyArray<Draft>,
  kind: "account" | "card",
  opening: number | null,
): ReadonlyArray<StatementRow> => {
  let previous = opening;
  return drafts.map((draft, index) => {
    let direction = draft.direction;
    if (direction === null && previous !== null && draft.balanceMinor !== null) {
      const moved = draft.balanceMinor - previous;
      if (Math.abs(moved) === draft.amountMinor)
        direction = moved > 0 === (kind === "account") ? "credit" : "debit";
    }
    if (direction === null)
      direction =
        kind === "card"
          ? draft.negative
            ? "credit"
            : "debit"
          : draft.negative
            ? "debit"
            : "credit";
    if (draft.balanceMinor !== null) previous = draft.balanceMinor;
    const foreign = FOREIGN.exec(draft.description);
    const foreignAmount =
      foreign === null
        ? undefined
        : parseAmount(foreign[2] ?? foreign[3] ?? "", currencyDigits((foreign[1] ?? foreign[4])!));
    return {
      index,
      date: draft.date,
      description: draft.description.slice(0, 500),
      reference: draft.reference === null ? null : draft.reference.slice(0, 120),
      amountMinor: draft.amountMinor,
      direction,
      balanceMinor: draft.balanceMinor,
      foreign:
        foreign === null || foreignAmount === undefined
          ? null
          : { currency: (foreign[1] ?? foreign[4])!, amountMinor: foreignAmount.minor },
    };
  });
};

/** A signed amount for people; only ever given one `isExact` holds. */
export const signedMoney = (value: number | bigint, currency: string) => {
  const minor = BigInt(value);
  return `${minor < 0n ? "−" : ""}${formatMoney({ minor: Number(minor < 0n ? -minor : minor), currency })}`;
};
const money = signedMoney;

/**
 * Whether the statement adds up: opening plus credits less debits is closing (a card's dues go
 * the other way), and each running balance follows from the one before it. Never guessed.
 */
export const checkBalances = (
  kind: "account" | "card",
  rows: ReadonlyArray<StatementRow>,
  opening: number | null,
  closing: number | null,
  currency: string,
): BalanceCheck => {
  const sign = (row: StatementRow) =>
    BigInt(
      (row.direction === "credit") === (kind === "account") ? row.amountMinor : -row.amountMinor,
    );
  const tooLarge = { status: "off", line: TOO_LARGE } as const;
  let previous = opening === null ? null : BigInt(opening);
  for (const row of rows) {
    if (row.balanceMinor === null) continue;
    if (previous !== null && previous + sign(row) !== BigInt(row.balanceMinor))
      return isExact(previous + sign(row))
        ? {
            status: "off",
            line: `The running balance doesn't follow on ${row.date} (row ${row.index + 1}): ${money(previous, currency)} ${sign(row) >= 0n ? "+" : "−"} ${money(row.amountMinor, currency)} isn't the ${money(row.balanceMinor, currency)} shown. A row may be missing or misread.`,
          }
        : tooLarge;
    previous = BigInt(row.balanceMinor);
  }
  const total = (some: ReadonlyArray<StatementRow>, each: (row: StatementRow) => bigint) =>
    some.reduce((sum, row) => sum + each(row), 0n);
  const net = total(rows, sign);
  const firstBalance = rows.find((row) => row.balanceMinor !== null);
  const start =
    opening !== null
      ? BigInt(opening)
      : firstBalance === undefined
        ? null
        : BigInt(firstBalance.balanceMinor!) - total(rows.slice(0, firstBalance.index + 1), sign);
  const last = rows.findLast((row) => row.balanceMinor !== null)?.balanceMinor ?? null;
  const end = closing ?? last;
  if (start === null || end === null)
    return {
      status: "unchecked",
      line: "The statement gives no balances, so Kin couldn't check its totals.",
    };
  const credits = total(
    rows.filter((row) => row.direction === "credit"),
    (row) => BigInt(row.amountMinor),
  );
  const debits = total(
    rows.filter((row) => row.direction === "debit"),
    (row) => BigInt(row.amountMinor),
  );
  if (![net, start, credits, debits, start + net].every(isExact)) return tooLarge;
  const sum =
    kind === "account"
      ? `${money(start, currency)} + credits ${money(credits, currency)} − debits ${money(debits, currency)}`
      : `${money(start, currency)} + spends ${money(debits, currency)} − payments ${money(credits, currency)}`;
  const gap = start + net - BigInt(end);
  if (gap !== 0n)
    return {
      status: "off",
      line: `It doesn't add up: ${sum} is ${money(start + net, currency)}, but the statement's closing balance is ${money(end, currency)}, ${money(gap < 0n ? -gap : gap, currency)} apart.`,
    };
  return { status: "adds_up", line: `It adds up: ${sum} = ${money(end, currency)}.` };
};

/** A file past one of the readers' bounds: reported as unreadable, never read further. */
export class TooLarge extends Schema.TaggedError<TooLarge>()("KinStatementTooLarge", {
  reason: Schema.String,
}) {}

/** The widest line Kin keeps and the most cells and lines it reads from one file. */
export const LINE_CAPS = { width: 256, cells: 2_000_000, lines: 100_000 } as const;
export const EMPTY_CELL: Cell = { text: "" };
const TOO_MANY = "The file has far more cells than a statement; send a shorter period.";

/** Counts every cell a reader makes, padding included, and stops it at the caps. */
export const cellBudget = () => {
  let cells = 0;
  let lines = 0;
  return {
    cells: (count: number) => {
      cells += count;
      if (cells > LINE_CAPS.cells) throw new TooLarge({ reason: TOO_MANY });
    },
    line: () => {
      lines += 1;
      if (lines > LINE_CAPS.lines) throw new TooLarge({ reason: TOO_MANY });
    },
  };
};
const cellOf = (text: string): Cell => (text === "" ? EMPTY_CELL : { text });

/** Reads CSV, or tab-, semicolon- or pipe-separated text, quotes and line breaks in quotes included. */
export const delimitedLines = (text: string): ReadonlyArray<Line> => {
  const sample = text.slice(0, 20_000).split(/\r?\n/).slice(0, 60);
  const delimiter =
    [",", "\t", ";", "|"]
      .map((one) => ({
        one,
        score: sample.filter((line) => line.split(one).length >= 4).length,
      }))
      .toSorted((left, right) => right.score - left.score)[0]?.one ?? ",";
  const budget = cellBudget();
  const lines: Array<Array<Cell>> = [];
  let cells: Array<Cell> = [];
  let cell = "";
  let quoted = false;
  const push = () => {
    if (cells.length < LINE_CAPS.width) {
      budget.cells(1);
      cells.push(cellOf(cell.trim()));
    }
    cell = "";
  };
  const end = () => {
    budget.line();
    lines.push(cells);
    cells = [];
  };
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else if (cell.length < 4_000) cell += char;
      continue;
    }
    if (char === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (char === delimiter) push();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at += 1;
      push();
      end();
    } else if (cell.length < 4_000) cell += char;
  }
  if (cell !== "" || cells.length > 0) {
    push();
    end();
  }
  return lines;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const codePoint = (value: number, whole: string) =>
  Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
const unescape = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,8});/gi, (whole, name: string) =>
    name.startsWith("#x") || name.startsWith("#X")
      ? codePoint(Number.parseInt(name.slice(2), 16), whole)
      : name.startsWith("#")
        ? codePoint(Number(name.slice(1)), whole)
        : (ENTITIES[name.toLowerCase()] ?? whole),
  );

/**
 * An HTML table, as some banks' ".xls" downloads are: each row's cells as text. One pass over
 * the tags, closing a cell or row where the next one starts, as browsers do.
 */
export const htmlLines = (html: string): ReadonlyArray<Line> => {
  const budget = cellBudget();
  const lines: Array<Array<Cell>> = [];
  let row: Array<Cell> | undefined;
  let cell: Array<string> | undefined;
  let size = 0;
  const endCell = () => {
    if (cell === undefined) return;
    if (row !== undefined && row.length < LINE_CAPS.width) {
      budget.cells(1);
      row.push(cellOf(unescape(cell.join("")).replace(/\s+/g, " ").trim()));
    }
    cell = undefined;
    size = 0;
  };
  const endRow = () => {
    endCell();
    if (row === undefined) return;
    budget.line();
    lines.push(row);
    row = undefined;
  };
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    const text = html.slice(at, open === -1 ? html.length : open);
    if (cell !== undefined && text !== "" && size < 4_000) {
      cell.push(text);
      size += text.length;
    }
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      at = close === -1 ? html.length : close + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    at = close + 1;
    const head = /^(\/?)\s*([a-z][a-z0-9]{0,15})/i.exec(
      html.slice(open + 1, Math.min(close, open + 40)),
    );
    if (head === null) continue;
    const closing = head[1] === "/";
    const name = head[2]!.toLowerCase();
    if (name === "tr") {
      endRow();
      if (!closing) row = [];
    } else if (name === "td" || name === "th") {
      endCell();
      if (!closing) {
        row ??= [];
        cell = [];
      }
    } else if (name === "table" && closing) endRow();
    else if (name === "br" && cell !== undefined) cell.push(" ");
    else if ((name === "script" || name === "style") && !closing) {
      const end = new RegExp(`</${name}`, "gi");
      end.lastIndex = at;
      at = end.exec(html)?.index ?? html.length;
    }
  }
  endRow();
  return lines;
};
