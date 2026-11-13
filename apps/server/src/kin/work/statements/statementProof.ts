import { formatMoney } from "../money.ts";
import {
  type BalanceCheck,
  type Direction,
  END_OF_TABLE,
  FOREIGN,
  looksLikeMoney,
  parseAmount,
  parseDay,
  type StatementRow,
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
const signed = (minor: number, currency: string) =>
  `${minor < 0 ? "−" : ""}${formatMoney({ minor: Math.abs(minor), currency })}`;
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
const where = (index: number, page: number, date: string, minor: number, currency: string) =>
  `Row ${index + 1} (page ${page}, ${day(date)}, ${signed(minor, currency)})`;

/** The line naming a date, the narration and an amount: the columns the rows sit under. */
export const isHeaderLine = (line: string) =>
  /\bdate\b/i.test(line) &&
  /narration|description|particular|detail/i.test(line) &&
  /withdrawal|debit|deposit|credit|amount/i.test(line);

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
const tokensOf = (line: string): ReadonlyArray<Token> => {
  const words = [...line.matchAll(/\S+/g)];
  return words.flatMap((word, at) => {
    if (!looksLikeMoney(word[0]) || CODES.has(words[at - 1]?.[0].toUpperCase() ?? "")) return [];
    const mark = /^(cr|dr)\.?$/i.test(words[at + 1]?.[0] ?? "") ? ` ${words[at + 1]![0]}` : "";
    const amount = parseAmount(`${word[0]}${mark}`);
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
  readonly columns: ReadonlyArray<Column>;
  /** The line before it and its block, squashed, for its narration and reference. */
  said: string;
  raw: string;
  used: boolean;
};

/** The lines of a page that start with a date, each with the block its narration wraps onto. */
const datedOf = (text: string, header: ReadonlyArray<Column>) => {
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
        own: tokensOf(line),
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
        current.wrapped.push(...tokensOf(line));
        current.said += squash(line);
        current.raw += ` ${line.trim()}`;
      }
    }
  }
  return dated;
};

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
};

const IN_WORDS: Readonly<Record<Role, string>> = {
  debit: "the withdrawal (debit) column",
  credit: "the deposit (credit) column",
  amount: "the amount column",
  balance: "the balance column",
};

/**
 * Ties each row to a dated line of its page's text: its date, amount and any balance must be
 * printed there, its narration's first words and reference in that line's block. The numbers and
 * direction are taken from the text; every dated line is one row or marked as none.
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
  const money = (minor: number) => signed(minor, currency);
  const headerLine = input.texts.flatMap((text) => text.split("\n")).find(isHeaderLine);
  const header = headerLine === undefined ? [] : columnsOf(headerLine);
  const problems: Array<Problem> = [];
  const unproven = new Set<string>();
  const add = (problem: Problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };
  const sign = (direction: Direction, minor: number) =>
    (direction === "credit") === (input.kind === "account") ? minor : -minor;
  let running = input.opening;
  let index = 0;
  let undirected = 0;
  const pages = input.pages.map(({ page, rows, notRows = [] }) => {
    const text = input.texts[page - 1] ?? "";
    const dated = datedOf(text, header);
    let last = -1;
    const bound = rows.map((row): StatementRow => {
      const at = index++;
      const named = where(at, page, row.date, row.amountMinor, currency);
      if (text === "") {
        unproven.add(`Page ${page} has no text, so Kin couldn't check its rows against the PDF.`);
        if (row.balanceMinor !== null) running = row.balanceMinor;
        else if (running !== null) running += sign(row.direction, row.amountMinor);
        return { ...row, index: at, foreign: null };
      }
      const lead = squash(row.description).slice(0, 8);
      const reference = squash(row.reference ?? "").replace(/^0+/, "");
      const fit = (line: Dated) => {
        const tokens = [...line.own, ...line.wrapped];
        const amount = tokens.find(
          (one) => one.minor === row.amountMinor && roleOf(one, line.columns) !== "balance",
        );
        const balanceOf = (one: Token) =>
          one.negative || one.marker === "debit" ? -one.minor : one.minor;
        const balance =
          amount === undefined
            ? undefined
            : row.balanceMinor !== null
              ? (tokens.find(
                  (one) =>
                    one !== amount &&
                    balanceOf(one) === row.balanceMinor &&
                    roleOf(one, line.columns) === "balance",
                ) ?? tokens.find((one) => one !== amount && balanceOf(one) === row.balanceMinor))
              : line.own.find((one) => one !== amount && roleOf(one, line.columns) === "balance");
        return {
          amount,
          balance: balance === undefined ? null : balanceOf(balance),
          printsBalance: row.balanceMinor === null || balance !== undefined,
          words: line.said.includes(lead) && line.said.includes(reference),
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
        if (row.balanceMinor !== null) running = row.balanceMinor;
        else if (running !== null) running += sign(row.direction, row.amountMinor);
        return { ...row, index: at, foreign: null };
      }
      found.line.used = true;
      last = found.position;
      const { amount, balance } = fit(found.line);
      const role = roleOf(amount!, found.line.columns);
      const moved =
        running === null || balance === null || Math.abs(balance - running) !== row.amountMinor
          ? undefined
          : balance > running === (input.kind === "account")
            ? ("credit" as const)
            : ("debit" as const);
      const proven: { direction: Direction; why: string } | undefined =
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
      if (proven === undefined) undirected += 1;
      else if (proven.direction !== row.direction)
        add({
          page,
          row: at,
          line: `${named}: ${proven.why}, so it is a ${proven.direction}, not a ${row.direction}.`,
        });
      const direction = proven?.direction ?? row.direction;
      running = balance ?? (running === null ? null : running + sign(direction, row.amountMinor));
      const foreign = FOREIGN.exec(found.line.raw);
      const foreignAmount =
        foreign === null ? undefined : parseAmount(foreign[2] ?? foreign[3] ?? "");
      const code = foreign === null ? undefined : (foreign[1] ?? foreign[4])!;
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
    if (text !== "") {
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
        const roles = line.own.map((one) => roleOf(one, line.columns));
        const pair =
          line.columns.length === 0
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
  return { pages, problems, unproven: [...unproven] };
};

/** Rows read from the whole file, each on the page whose next dated line prints its amount. */
export const pagesFor = (texts: ReadonlyArray<string>, rows: ReadonlyArray<ReadRow>) => {
  const headerLine = texts.flatMap((text) => text.split("\n")).find(isHeaderLine);
  const header = headerLine === undefined ? [] : columnsOf(headerLine);
  const lines = texts.flatMap((text, at) =>
    datedOf(text, header).map((line) => ({ ...line, page: at + 1 })),
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

/** Whether this amount is printed anywhere in the statement's text. */
export const printed = (texts: ReadonlyArray<string>, minor: number) =>
  texts.some((text) =>
    text.split("\n").some((line) => tokensOf(line).some((one) => one.minor === Math.abs(minor))),
  );

export const proveStatement = (input: {
  readonly kind: "account" | "card";
  readonly currency: string;
  readonly opening: number | null;
  readonly closing: number | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly pages: ReadonlyArray<ProofPage>;
  /** What tying the rows to the PDF's text found; absent when there was no text to tie them to. */
  readonly bound?: Pick<Bound, "problems" | "unproven">;
}): Proof => {
  const { currency } = input;
  const money = (minor: number) => signed(minor, currency);
  const sign = (row: StatementRow) =>
    (row.direction === "credit") === (input.kind === "account")
      ? row.amountMinor
      : -row.amountMinor;
  const problems: Array<Problem> = [...(input.bound?.problems ?? [])].slice(0, MAX_PROBLEMS);
  const add = (problem: Problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };
  const rows = input.pages.flatMap((page) => page.rows.map((row) => ({ row, page: page.page })));
  const at = (row: StatementRow, page: number) =>
    where(row.index, page, row.date, row.amountMinor, currency);

  // Each printed balance follows from the one before it; a break resets, so later ones still count.
  let previous = input.opening;
  for (const { row, page } of rows) {
    if (row.balanceMinor === null) {
      if (previous !== null) previous += sign(row);
      continue;
    }
    if (previous !== null && previous + sign(row) !== row.balanceMinor)
      add({
        page,
        row: row.index,
        line: `${at(row, page)}: ${money(previous)} ${sign(row) >= 0 ? "+" : "−"} ${money(row.amountMinor)} is ${money(previous + sign(row))}, but the balance printed beside it is ${money(row.balanceMinor)}, ${money(Math.abs(previous + sign(row) - row.balanceMinor))} apart. A row before it may be missing, or this one misread.`,
      });
    previous = row.balanceMinor;
  }

  const net = rows.reduce((sum, { row }) => sum + sign(row), 0);
  const total = (direction: Direction) =>
    rows
      .filter(({ row }) => row.direction === direction)
      .reduce((sum, { row }) => sum + row.amountMinor, 0);
  const sum =
    input.kind === "account"
      ? `${money(input.opening ?? 0)} + credits ${money(total("credit"))} − debits ${money(total("debit"))}`
      : `${money(input.opening ?? 0)} + spends ${money(total("debit"))} − payments ${money(total("credit"))}`;
  const complete = input.opening !== null && input.closing !== null;
  if (complete && input.opening! + net !== input.closing!)
    add({
      page: null,
      row: null,
      line: `It doesn't add up: ${sum} is ${money(input.opening! + net)}, but the statement's closing balance is ${money(input.closing!)}, ${money(Math.abs(input.opening! + net - input.closing!))} apart.`,
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

  const unproven = input.bound?.unproven ?? [];
  const hasBalances = rows.some(({ row }) => row.balanceMinor !== null);
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
