import { currencyDigits } from "../money.ts";
import {
  type BalanceCheck,
  type Direction,
  END_OF_TABLE,
  FOREIGN,
  isExact,
  isHeaderLine,
  looksLikeMoney,
  parseAmount,
  parseDay,
  signedMoney,
  type StatementRow,
  TOO_LARGE,
} from "./statementTable.ts";

/**
 * The server's proof of a statement's rows, whoever read them: Kin's table reader or a lead
 * reading the pages. Each row is tied to a dated line of the PDF's own text, which supplies its
 * numbers and direction; then plain arithmetic, with the place each check fails, so the reader
 * can look at that page again. Problems name pages, dates and amounts, never the bank's words.
 */

export type ProofPage = {
  /** From 1, as the file numbers its pages. */
  readonly page: number;
  readonly rows: ReadonlyArray<StatementRow>;
};
export type Problem = {
  readonly page: number | null;
  /** The row's place in the whole statement, from 0. */
  readonly row: number | null;
  readonly line: string;
};
export type Proof = { readonly check: BalanceCheck; readonly problems: ReadonlyArray<Problem> };

const MAX_PROBLEMS = 20;
const SHORT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (date: string) => SHORT.format(Date.parse(`${date}T00:00:00Z`));
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
const where = (index: number, page: number, date: string, minor: number, currency: string) =>
  `Row ${index + 1} (page ${page}, ${day(date)}, ${signedMoney(minor, currency)})`;

type Role = "debit" | "credit" | "amount" | "balance";
type Column = { readonly role: Role; readonly start: number; readonly end: number };
type Token = {
  readonly minor: number;
  readonly negative: boolean;
  readonly marker: Direction | null;
  readonly start: number;
  readonly end: number;
};

const LABEL =
  /(?:withdrawals?|debits?|deposits?|credits?)(?:\s+(?:amt|amount)\b\.?)?|(?:closing\s+|running\s+|available\s+)?\bbal(?:ance)?\b\.?|\b(?:amount|amt)\b\.?(?:\s*\((?:in\s+)?(?:rs|inr)\.?\))?/gi;
/** A header's money columns by where their labels sit, in characters of the page's text. */
const columnsOf = (line: string): ReadonlyArray<Column> =>
  [...line.matchAll(LABEL)].map((found) => {
    const label = found[0].toLowerCase();
    return {
      role: /bal/.test(label)
        ? "balance"
        : /withdraw|debit/.test(label)
          ? "debit"
          : /deposit|credit/.test(label)
            ? "credit"
            : "amount",
      start: found.index,
      end: found.index + found[0].length,
    };
  });

const CODES = new Set(
  "USD EUR GBP SGD AED AUD CAD JPY CHF HKD NZD SEK THB MYR CNY ZAR SAR QAR".split(" "),
);
/** The money printed on a line, where it sits; a foreign amount after its code isn't one. */
const tokensOf = (line: string, digits: number): ReadonlyArray<Token> => {
  const words = [...line.matchAll(/\S+/g)];
  return words.flatMap((word, at) => {
    if (!looksLikeMoney(word[0], digits) || CODES.has(words[at - 1]?.[0].toUpperCase() ?? ""))
      return [];
    const mark = /^(cr|dr)\.?$/i.test(words[at + 1]?.[0] ?? "") ? ` ${words[at + 1]![0]}` : "";
    const amount = parseAmount(`${word[0]}${mark}`, digits);
    return amount === undefined
      ? []
      : [{ ...amount, start: word.index, end: word.index + word[0].length }];
  });
};
const roleOf = (token: Token, columns: ReadonlyArray<Column>): Role | undefined => {
  const center = (token.start + token.end) / 2;
  const far = (column: Column) =>
    Math.min(Math.abs(column.end - token.end), Math.abs((column.start + column.end) / 2 - center));
  const nearest = columns.toSorted((left, right) => far(left) - far(right))[0];
  return nearest !== undefined && far(nearest) <= 30 ? nearest.role : undefined;
};

type Dated = {
  readonly date: string;
  /** Money on the dated line itself, then on the lines its narration wraps onto. */
  readonly own: ReadonlyArray<Token>;
  readonly wrapped: Array<Token>;
  columns: ReadonlyArray<Column>;
  /** Without columns: which of `own`, from the right, the balance chain shows is the balance. */
  balanceAt?: number;
  /** The line before it and its block, squashed, for its narration and reference. */
  said: string;
  raw: string;
  used: boolean;
};

/** The lines of a page that start with a date, each with the block its narration wraps onto. */
const datedOf = (text: string, header: ReadonlyArray<Column>, digits: number) => {
  const lines = text.split("\n");
  let columns = header;
  let current: Dated | undefined;
  const dated: Array<Dated> = [];
  for (const [at, line] of lines.entries()) {
    if (isHeaderLine(line)) {
      columns = columnsOf(line);
      current = undefined;
      continue;
    }
    const date = parseDay(line.trimStart());
    if (date !== undefined) {
      const before = lines[at - 1] ?? "";
      const prior =
        current === undefined && !isHeaderLine(before) && parseDay(before.trimStart()) === undefined
          ? before
          : "";
      current = {
        date,
        own: tokensOf(line, digits),
        wrapped: [],
        columns,
        said: squash(`${prior} ${line}`),
        raw: line.trim(),
        used: false,
      };
      dated.push(current);
    } else if (current !== undefined) {
      if (END_OF_TABLE.test(line.trim())) current = undefined;
      else {
        current.wrapped.push(...tokensOf(line, digits));
        current.said += squash(line);
        current.raw += ` ${line.trim()}`;
      }
    }
  }
  return dated;
};

/** The minor units a token stands for, signed as a balance prints it. */
const valueOf = (one: Token) => (one.negative || one.marker === "debit" ? -one.minor : one.minor);

/**
 * Settles where a page's money sits, from the file alone: a header carried from an earlier page
 * holds where every dated line prints money under its columns; with no header, the balance is the
 * one place on each line that runs on from row to row, at least once and never broken.
 */
const settleColumns = (dated: ReadonlyArray<Dated>, carried: ReadonlyArray<Column>) => {
  const onCarried = dated.filter((line) => line.columns === carried && carried.length > 0);
  const fits = onCarried.every(
    (line) => line.own.length === 0 || line.own.some((one) => roleOf(one, carried) !== undefined),
  );
  const loose = fits ? [] : onCarried;
  const bare = [...dated.filter((line) => line.columns.length === 0), ...loose];
  if (bare.length === 0) return;
  const ways = [0, 1, 2].filter((k) => {
    let holds = 0;
    for (const [at, line] of bare.entries()) {
      const before = bare[at - 1];
      if (before === undefined || before.own.length < 2 || line.own.length < 2) continue;
      if (k >= before.own.length || k >= line.own.length) return false;
      const from = valueOf(before.own[before.own.length - 1 - k]!);
      const to = valueOf(line.own[line.own.length - 1 - k]!);
      const moved = Math.abs(to - from);
      if (!line.own.some((one, place) => place !== line.own.length - 1 - k && one.minor === moved))
        return false;
      holds += 1;
    }
    return holds > 0;
  });
  for (const line of bare) {
    if (loose.includes(line)) line.columns = [];
    if (ways.length === 1) line.balanceAt = ways[0]!;
  }
};

/** A token's column: by the header's labels, or by the balance chain on a page without one. */
const roleIn = (line: Dated, one: Token): Role | undefined => {
  if (line.columns.length > 0) return roleOf(one, line.columns);
  if (line.balanceAt === undefined) return undefined;
  const at = line.own.indexOf(one);
  return at === -1 ? undefined : at === line.own.length - 1 - line.balanceAt ? "balance" : "amount";
};
const settled = (line: Dated) => line.columns.length > 0 || line.balanceAt !== undefined;

/** How many lines of a page's text start with a date: what its rows must account for. */
export const datedLinesOf = (text: string) =>
  text === ""
    ? null
    : text.split("\n").filter((line) => parseDay(line.trimStart()) !== undefined).length;

export type ReadRow = Omit<StatementRow, "index" | "foreign">;
/** A dated line the reader says is no transaction, by its date and the words after it. */
export type NotRow = { readonly date: string; readonly text: string };
export type Bound = {
  readonly pages: ReadonlyArray<ProofPage>;
  readonly problems: ReadonlyArray<Problem>;
  /** Why the rows can't be proven, though nothing contradicts them. */
  readonly unproven: ReadonlyArray<string>;
  /** Pages with no text and no rows: proven only by the balances running on across them. */
  readonly gaps: ReadonlyArray<number>;
  /** The balance before the first row and after the last, where the file's columns prove them. */
  readonly ends: { readonly opening: number | null; readonly closing: number | null };
};

const IN_WORDS: Readonly<Record<Role, string>> = {
  debit: "the withdrawal (debit) column",
  credit: "the deposit (credit) column",
  amount: "the amount column",
  balance: "the balance column",
};
const MONEY_ROLES = new Set<Role | undefined>(["debit", "credit", "amount"]);
const noText = (page: number) =>
  `Page ${page} could not be checked against the file: it has no text Kin can read.`;
const unsettled = (page: number) =>
  `Page ${page} prints no column header Kin could place its numbers by, and its balances don't run on from row to row, so Kin couldn't tell each line's amount from its balance.`;

/**
 * Ties each row to a dated line of its page's text: its date, amount and any balance must be
 * printed there, in the columns the file itself shows, its narration's first words and reference
 * in that line's block. The numbers and direction are taken from the text; every dated line is
 * one row or marked as none.
 */
export const bindRows = (input: {
  readonly kind: "account" | "card";
  readonly currency: string;
  readonly opening: number | null;
  /** Every page's text, from page 1; "" for a page with no text layer. */
  readonly texts: ReadonlyArray<string>;
  readonly pages: ReadonlyArray<{
    readonly page: number;
    readonly rows: ReadonlyArray<ReadRow>;
    readonly notRows?: ReadonlyArray<NotRow>;
  }>;
}): Bound => {
  const { currency } = input;
  const digits = currencyDigits(currency);
  const money = (minor: number) => signedMoney(minor, currency);
  const headerLine = input.texts.flatMap((text) => text.split("\n")).find(isHeaderLine);
  const header = headerLine === undefined ? [] : columnsOf(headerLine);
  const problems: Array<Problem> = [];
  const unproven = new Set<string>();
  const gaps: Array<number> = [];
  const add = (problem: Problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };
  const sign = (direction: Direction, minor: number) =>
    BigInt((direction === "credit") === (input.kind === "account") ? minor : -minor);
  let running = input.opening === null ? null : BigInt(input.opening);
  const follow = (row: ReadRow, direction: Direction, balance: number | null) => {
    running =
      balance !== null
        ? BigInt(balance)
        : running === null
          ? null
          : running + sign(direction, row.amountMinor);
  };
  const proven = new Set<number>();
  // Rows whose way the file itself shows, not the balance before them: the opening may be a guess.
  const placed = new Set<number>();
  let index = 0;
  let undirected = 0;
  const pages = input.pages.map(({ page, rows, notRows = [] }) => {
    const text = input.texts[page - 1] ?? "";
    const blank = text.trim() === "";
    if (blank && rows.length === 0) gaps.push(page);
    const dated = blank ? [] : datedOf(text, header, digits);
    settleColumns(dated, header);
    let last = -1;
    const bound = rows.map((row): StatementRow => {
      const at = index++;
      const named = where(at, page, row.date, row.amountMinor, currency);
      if (blank) {
        unproven.add(noText(page));
        follow(row, row.direction, row.balanceMinor);
        return { ...row, index: at, foreign: null };
      }
      const lead = squash(row.description).slice(0, 8);
      const reference = squash(row.reference ?? "").replace(/^0+/, "");
      const fit = (line: Dated) => {
        const tokens = [...line.own, ...line.wrapped];
        const sure = settled(line);
        const amount = tokens.find(
          (one) =>
            one.minor === row.amountMinor &&
            (sure ? MONEY_ROLES.has(roleIn(line, one)) : roleIn(line, one) !== "balance"),
        );
        const balance =
          amount === undefined
            ? undefined
            : row.balanceMinor !== null
              ? tokens.find(
                  (one) =>
                    one !== amount &&
                    valueOf(one) === row.balanceMinor &&
                    (!sure || roleIn(line, one) === "balance"),
                )
              : line.own.find((one) => one !== amount && roleIn(line, one) === "balance");
        return {
          amount,
          balance: balance === undefined ? null : valueOf(balance),
          printsBalance: row.balanceMinor === null || balance !== undefined,
          words: line.said.includes(lead) && line.said.includes(reference),
          // Two numbers and nothing in the file to say which is which: the reader's word only.
          guessed: !sure && line.own.length + line.wrapped.length > 1,
        };
      };
      const order = dated
        .map((line, position) => ({ line, position }))
        .filter(({ line }) => !line.used && line.date === row.date)
        .toSorted((left, right) => Number(left.position < last) - Number(right.position < last));
      const found = order.find(({ line }) => {
        const one = fit(line);
        return one.amount !== undefined && one.printsBalance && one.words;
      });
      if (found === undefined) {
        const near = order.map(({ line }) => fit(line));
        add({
          page,
          row: at,
          line:
            order.length === 0
              ? `${named} isn't on page ${page}: no line there dated ${day(row.date)} is left for it.`
              : !near.some((one) => one.amount !== undefined)
                ? `${named}: no line dated ${day(row.date)} on page ${page} prints ${money(row.amountMinor)}.`
                : !near.some((one) => one.amount !== undefined && one.printsBalance)
                  ? `${named}: the balance ${money(row.balanceMinor ?? 0)} isn't printed on its line.`
                  : `${named}: its narration's first words or its reference aren't on the line dated ${day(row.date)} that prints ${money(row.amountMinor)}.`,
        });
        follow(row, row.direction, row.balanceMinor);
        return { ...row, index: at, foreign: null };
      }
      found.line.used = true;
      last = found.position;
      const { amount, balance, guessed } = fit(found.line);
      if (guessed) unproven.add(unsettled(page));
      else if (balance !== null) proven.add(at);
      const role = roleIn(found.line, amount!);
      const step =
        running === null || balance === null || guessed ? null : BigInt(balance) - running;
      const moved =
        step === null || (step !== BigInt(row.amountMinor) && step !== -BigInt(row.amountMinor))
          ? undefined
          : step > 0n === (input.kind === "account")
            ? ("credit" as const)
            : ("debit" as const);
      const shown: { direction: Direction; why: string } | undefined =
        role === "debit" || role === "credit"
          ? { direction: role, why: `its amount is printed in ${IN_WORDS[role]}` }
          : amount!.marker !== null
            ? {
                direction: amount!.marker,
                why: `its amount is marked ${amount!.marker === "credit" ? "Cr" : "Dr"}`,
              }
            : moved !== undefined
              ? { direction: moved, why: "the balance beside it moves by its amount that way" }
              : undefined;
      if (role === "debit" || role === "credit" || amount!.marker !== null) placed.add(at);
      if (shown === undefined) undirected += 1;
      else if (shown.direction !== row.direction)
        add({
          page,
          row: at,
          line: `${named}: ${shown.why}, so it is a ${shown.direction}, not a ${row.direction}.`,
        });
      const direction = shown?.direction ?? row.direction;
      follow(row, direction, balance);
      const foreign = FOREIGN.exec(found.line.raw);
      const code = foreign === null ? undefined : (foreign[1] ?? foreign[4])!;
      const foreignAmount =
        foreign === null || code === undefined
          ? undefined
          : parseAmount(foreign[2] ?? foreign[3] ?? "", currencyDigits(code));
      return {
        ...row,
        index: at,
        amountMinor: amount!.minor,
        balanceMinor: balance,
        direction,
        foreign:
          code === undefined || foreignAmount === undefined || code === currency
            ? null
            : { currency: code, amountMinor: foreignAmount.minor },
      };
    });
    if (!blank) {
      for (const other of notRows) {
        const words = squash(other.text).slice(0, 8);
        const line = dated.find(
          (one) => !one.used && one.date === other.date && one.said.includes(words),
        );
        if (line === undefined) {
          add({
            page,
            row: null,
            line: `Page ${page}: no line dated ${day(other.date)} with those words is left to mark as not a transaction.`,
          });
          continue;
        }
        const roles = line.own.map((one) => roleIn(line, one));
        const pair = !settled(line)
          ? line.own.length >= 2
          : roles.includes("balance") && roles.some((role) => role !== "balance");
        if (pair)
          add({
            page,
            row: null,
            line: `Page ${page}: the line dated ${day(other.date)} you marked as not a transaction prints an amount and a balance (${line.own.map((one) => money(one.minor)).join(", ")}): give its row.`,
          });
        else line.used = true;
      }
      for (const line of dated.filter((one) => !one.used))
        add({
          page,
          row: null,
          line: `Page ${page}: the line dated ${day(line.date)}${line.own.length === 0 ? "" : ` that prints ${line.own.map((one) => money(one.minor)).join(", ")}`} has no row. Give its row, or list it in notTransactions if it isn't one.`,
        });
    }
    return { page, rows: bound };
  });
  if (undirected > 0)
    unproven.add(
      `Kin couldn't tell from the statement's text which way ${undirected} row${undirected === 1 ? "" : "s"} went: no debit or credit column, Cr or Dr mark, or running balance shows it.`,
    );
  const all = pages.flatMap((page) => page.rows);
  const first = all[0];
  const final = all.at(-1);
  const before =
    first === undefined || !proven.has(first.index) || !placed.has(first.index)
      ? null
      : BigInt(first.balanceMinor!) - sign(first.direction, first.amountMinor);
  return {
    pages,
    problems,
    unproven: [...unproven],
    gaps,
    ends: {
      opening: before === null || !isExact(before) ? null : Number(before),
      closing: final === undefined || !proven.has(final.index) ? null : final.balanceMinor,
    },
  };
};

/** Rows read from the whole file, each on the page whose next dated line prints its amount. */
export const pagesFor = (
  texts: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadRow>,
  currency: string,
) => {
  const headerLine = texts.flatMap((text) => text.split("\n")).find(isHeaderLine);
  const header = headerLine === undefined ? [] : columnsOf(headerLine);
  const digits = currencyDigits(currency);
  const lines = texts.flatMap((text, at) =>
    datedOf(text, header, digits).map((line) => ({ ...line, page: at + 1 })),
  );
  const pages = texts.map((_, at) => ({ page: at + 1, rows: [] as Array<ReadRow> }));
  let next = 0;
  for (const row of rows) {
    const found = lines.findIndex(
      (line, at) =>
        at >= next &&
        line.date === row.date &&
        [...line.own, ...line.wrapped].some((one) => one.minor === row.amountMinor),
    );
    if (found !== -1) next = found + 1;
    const page = (found === -1 ? lines[next - 1]?.page : lines[found]!.page) ?? 1;
    pages[page - 1]?.rows.push(row);
  }
  return pages;
};

const LABELS = {
  opening: /\b(?:opening|previous|brought\s+forward|b\/f|last\s+statement)\b/i,
  closing: /\b(?:closing|carried\s+forward|c\/f|total\s+(?:amount\s+)?dues?|amount\s+due)\b/i,
};
/**
 * Whether the statement prints this as its opening or closing balance: beside its label, or on
 * the line under a row of labels. A figure printed anywhere else, such as a row's, isn't one.
 */
export const stated = (
  texts: ReadonlyArray<string>,
  which: "opening" | "closing",
  minor: number,
  currency: string,
) => {
  const digits = currencyDigits(currency);
  return texts.some((text) => {
    const lines = text.split("\n");
    return lines.some((line, at) => {
      if (!LABELS[which].test(line)) return false;
      const own = tokensOf(line, digits);
      const figures = own.length > 0 ? own : tokensOf(lines[at + 1] ?? "", digits);
      return figures.some((one) => one.minor === Math.abs(minor));
    });
  });
};

export const proveStatement = (input: {
  readonly kind: "account" | "card";
  readonly currency: string;
  readonly opening: number | null;
  readonly closing: number | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly pages: ReadonlyArray<ProofPage>;
  /** What tying the rows to the PDF's text found; absent when there was no text to tie them to. */
  readonly bound?: Pick<Bound, "problems" | "unproven"> & Partial<Pick<Bound, "gaps">>;
}): Proof => {
  const { currency } = input;
  const money = (minor: number | bigint) => signedMoney(minor, currency);
  const sign = (row: StatementRow) =>
    BigInt(
      (row.direction === "credit") === (input.kind === "account")
        ? row.amountMinor
        : -row.amountMinor,
    );
  const problems: Array<Problem> = [...(input.bound?.problems ?? [])].slice(0, MAX_PROBLEMS);
  const add = (problem: Problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };
  const rows = input.pages.flatMap((page) => page.rows.map((row) => ({ row, page: page.page })));
  const at = (row: StatementRow, page: number) =>
    where(row.index, page, row.date, row.amountMinor, currency);
  let exact = true;

  // Each printed balance follows from the one before it; a break resets, so later ones still count.
  let previous = input.opening === null ? null : BigInt(input.opening);
  for (const { row, page } of rows) {
    if (row.balanceMinor === null) {
      if (previous !== null) previous += sign(row);
      if (previous !== null && !isExact(previous)) exact = false;
      continue;
    }
    const expected = previous === null ? null : previous + sign(row);
    if (expected !== null && !isExact(expected)) exact = false;
    else if (expected !== null && expected !== BigInt(row.balanceMinor)) {
      const gap = expected - BigInt(row.balanceMinor);
      add({
        page,
        row: row.index,
        line: `${at(row, page)}: ${money(previous!)} ${sign(row) >= 0n ? "+" : "−"} ${money(row.amountMinor)} is ${money(expected)}, but the balance printed beside it is ${money(row.balanceMinor)}, ${money(gap < 0n ? -gap : gap)} apart. A row before it may be missing, or this one misread.`,
      });
    }
    previous = BigInt(row.balanceMinor);
  }

  const net = rows.reduce((sum, { row }) => sum + sign(row), 0n);
  const total = (direction: Direction) =>
    rows
      .filter(({ row }) => row.direction === direction)
      .reduce((sum, { row }) => sum + BigInt(row.amountMinor), 0n);
  const credits = total("credit");
  const debits = total("debit");
  const start = BigInt(input.opening ?? 0);
  if (![net, credits, debits, start + net].every(isExact)) exact = false;
  if (!exact) return { check: { status: "off", line: TOO_LARGE }, problems: [] };
  const sum =
    input.kind === "account"
      ? `${money(start)} + credits ${money(credits)} − debits ${money(debits)}`
      : `${money(start)} + spends ${money(debits)} − payments ${money(credits)}`;
  const complete = input.opening !== null && input.closing !== null;
  const apart = complete ? start + net - BigInt(input.closing!) : 0n;
  if (apart !== 0n)
    add({
      page: null,
      row: null,
      line: `It doesn't add up: ${sum} is ${money(start + net)}, but the statement's closing balance is ${money(input.closing!)}, ${money(apart < 0n ? -apart : apart)} apart.`,
    });

  for (const { row, page } of rows) {
    if (
      (input.from !== null && row.date < input.from) ||
      (input.to !== null && row.date > input.to)
    )
      add({
        page,
        row: row.index,
        line: `${at(row, page)} is dated outside the statement's period (${input.from ?? "…"} to ${input.to ?? "…"}).`,
      });
  }
  const dates = rows.map(({ row }) => row.date);
  // Banks list oldest or newest first; the way most rows go is the statement's.
  const steps = dates.slice(1).map((date, index) => Math.sign(date.localeCompare(dates[index]!)));
  const newestFirst = steps.filter((one) => one < 0).length > steps.filter((one) => one > 0).length;
  for (let index = 1; index < rows.length; index += 1) {
    const before = dates[index - 1]!;
    const date = dates[index]!;
    if (newestFirst ? date > before : date < before) {
      const { row, page } = rows[index]!;
      add({
        page,
        row: row.index,
        line: `${at(row, page)} is out of date order: the row before it is ${day(before)}.`,
      });
    }
  }

  const hasBalances = rows.some(({ row }) => row.balanceMinor !== null);
  // A page with no text holds nothing Kin can see; only balances running on across it prove so.
  const chained = complete && rows.every(({ row }) => row.balanceMinor !== null);
  const gaps = chained ? [] : (input.bound?.gaps ?? []);
  const unproven = [...(input.bound?.unproven ?? []), ...gaps.map(noText)];
  const check: BalanceCheck =
    problems.length > 0
      ? {
          status: "off",
          line: `${problems[0]!.line}${problems.length > 1 ? ` ${problems.length - 1} more place${problems.length === 2 ? "" : "s"} don't check out.` : ""}`,
        }
      : unproven.length > 0
        ? {
            status: "unchecked",
            line: `${unproven.join(" ")}${complete ? ` The rows' own sum does add up: ${sum} = ${money(input.closing!)}.` : ""}`,
          }
        : complete
          ? {
              status: "adds_up",
              line: `${input.bound === undefined ? "" : "Every row's date, amount and balance are printed on its page, and every dated line is counted. "}It adds up: ${sum} = ${money(input.closing!)}.`,
            }
          : {
              status: "unchecked",
              line: hasBalances
                ? "Each running balance follows from the one before it, but the statement shows no opening and closing balance to check the total against."
                : "The statement gives no balances, so Kin couldn't check its totals.",
            };
  return { check, problems };
};
