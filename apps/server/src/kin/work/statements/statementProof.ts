import { formatMoney } from "../money.ts";
import type { BalanceCheck, StatementRow } from "./statementTable.ts";

/**
 * The server's proof of a statement's rows, whoever read them: Kin's table reader or a lead
 * reading the pages. Plain arithmetic on the rows against what the statement prints, with the
 * place each check fails, so the reader can look at that page again.
 */

export type ProofPage = {
  /** From 1, as the file numbers its pages. */
  readonly page: number;
  readonly rows: ReadonlyArray<StatementRow>;
  /** Lines on the page that start with a date, when Kin has the page's text. */
  readonly dated: number | null;
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

export const proveStatement = (input: {
  readonly kind: "account" | "card";
  readonly currency: string;
  readonly opening: number | null;
  readonly closing: number | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly pages: ReadonlyArray<ProofPage>;
}): Proof => {
  const { currency } = input;
  const money = (minor: number) => signed(minor, currency);
  const sign = (row: StatementRow) =>
    (row.direction === "credit") === (input.kind === "account")
      ? row.amountMinor
      : -row.amountMinor;
  const problems: Array<Problem> = [];
  const add = (problem: Problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };
  const rows = input.pages.flatMap((page) => page.rows.map((row) => ({ row, page: page.page })));
  const where = (row: StatementRow, page: number) =>
    `Row ${row.index + 1} (page ${page}, ${day(row.date)}, ${money(row.amountMinor)})`;

  // Each printed balance follows from the one before it; a break resets, so later ones still count.
  const broken = new Set<number>();
  let previous = input.opening;
  for (const { row, page } of rows) {
    if (row.balanceMinor === null) {
      if (previous !== null) previous += sign(row);
      continue;
    }
    if (previous !== null && previous + sign(row) !== row.balanceMinor) {
      broken.add(page);
      add({
        page,
        row: row.index,
        line: `${where(row, page)}: ${money(previous)} ${sign(row) >= 0 ? "+" : "−"} ${money(row.amountMinor)} is ${money(previous + sign(row))}, but the balance printed beside it is ${money(row.balanceMinor)}, ${money(Math.abs(previous + sign(row) - row.balanceMinor))} apart. A row before it may be missing, or this one misread.`,
      });
    }
    previous = row.balanceMinor;
  }

  const net = rows.reduce((sum, { row }) => sum + sign(row), 0);
  const credits = rows
    .filter(({ row }) => row.direction === "credit")
    .reduce((sum, { row }) => sum + row.amountMinor, 0);
  const debits = rows
    .filter(({ row }) => row.direction === "debit")
    .reduce((sum, { row }) => sum + row.amountMinor, 0);
  const sum =
    input.kind === "account"
      ? `${money(input.opening ?? 0)} + credits ${money(credits)} − debits ${money(debits)}`
      : `${money(input.opening ?? 0)} + spends ${money(debits)} − payments ${money(credits)}`;
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
        line: `${where(row, page)} is dated outside the statement's period (${input.from ?? "…"} to ${input.to ?? "…"}).`,
      });
  }
  const dates = rows.map(({ row }) => row.date);
  // Banks list oldest or newest first; the way most rows go is the statement's.
  const steps = dates.slice(1).map((date, at) => Math.sign(date.localeCompare(dates[at]!)));
  const newestFirst = steps.filter((one) => one < 0).length > steps.filter((one) => one > 0).length;
  for (let at = 1; at < rows.length; at += 1) {
    const before = dates[at - 1]!;
    const date = dates[at]!;
    if (newestFirst ? date > before : date < before) {
      const { row, page } = rows[at]!;
      add({
        page,
        row: row.index,
        line: `${where(row, page)} is out of date order: the row before it is ${day(before)}.`,
      });
    }
  }

  // A page whose every row carries a balance that follows is already proven complete.
  for (const page of input.pages) {
    if (page.dated === null || page.rows.length === page.dated) continue;
    const chained =
      page.rows.length > 0 &&
      page.rows.every((row) => row.balanceMinor !== null) &&
      !broken.has(page.page);
    if (!chained)
      add({
        page: page.page,
        row: null,
        line: `Page ${page.page}: ${page.rows.length} row${page.rows.length === 1 ? " was" : "s were"} read, but ${page.dated} line${page.dated === 1 ? "" : "s"} on it start${page.dated === 1 ? "s" : ""} with a date.`,
      });
  }

  const hasBalances = rows.some(({ row }) => row.balanceMinor !== null);
  const check: BalanceCheck =
    problems.length > 0
      ? {
          status: "off",
          line: `${problems[0]!.line}${problems.length > 1 ? ` ${problems.length - 1} more place${problems.length === 2 ? "" : "s"} don't check out.` : ""}`,
        }
      : complete
        ? { status: "adds_up", line: `It adds up: ${sum} = ${money(input.closing!)}.` }
        : {
            status: "unchecked",
            line: hasBalances
              ? "Each running balance follows from the one before it, but the statement shows no opening and closing balance to check the total against."
              : "The statement gives no balances, so Kin couldn't check its totals.",
          };
  return { check, problems };
};
