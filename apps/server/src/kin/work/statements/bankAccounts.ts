import type { Statement, StatementRow } from "./statementTable.ts";

/**
 * Same kind, currency and last four digits (and bank, when both name one) are one account, gaps
 * and all, unless their days overlap with other figures or their full numbers differ. Without
 * digits, a statement joins the one account its balances chain with; else it can't be told apart.
 */

export interface AccountRead {
  readonly kind: Statement["kind"];
  readonly bank: string | null;
  readonly digits: string | null;
  /** The keyed full number; null when the file didn't print it. */
  readonly accountId: string | null;
  readonly currency: string;
  readonly from: string;
  readonly on: string;
  readonly opening: number | null;
  readonly closing: number | null;
}

export interface Account<R extends AccountRead> {
  /** Oldest first. */
  readonly reads: ReadonlyArray<R>;
  readonly digits: string | null;
  readonly bank: string | null;
  /** Another account may be this one: Kin can't tell them apart. */
  readonly apart: boolean;
}

const fold = (bank: string | null) => {
  const folded = (bank ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return folded === "" ? null : folded;
};
/** A bank's name as `sameAccounts` compares it; "" when none is printed. */
export const bankKey = (bank: string | null) => fold(bank) ?? "";
const agree = <T>(a: T | null, b: T | null) => a === null || b === null || a === b;
const sameRead = (a: AccountRead, b: AccountRead) =>
  a.from === b.from && a.on === b.on && a.opening === b.opening && a.closing === b.closing;
/** Two reads of one account never cover the same days with other figures. */
const overlaps = (a: AccountRead, b: AccountRead) =>
  !sameRead(a, b) && a.from < b.on && b.from < a.on;
const byDay = (a: AccountRead, b: AccountRead) =>
  a.on === b.on ? (a.from === b.from ? 0 : a.from < b.from ? -1 : 1) : a.on < b.on ? -1 : 1;

/** Whether `read` could be one of `reads`: nothing it states says otherwise. */
const fits = (reads: ReadonlyArray<AccountRead>, read: AccountRead) =>
  reads.every(
    (one) =>
      one.kind === read.kind &&
      one.currency === read.currency &&
      agree(one.digits, read.digits) &&
      agree(fold(one.bank), fold(read.bank)) &&
      agree(one.accountId, read.accountId) &&
      !overlaps(one, read),
  );

/** Its balances run on from the read just before it, or into the one just after it. */
const chains = (reads: ReadonlyArray<AccountRead>, read: AccountRead) => {
  const before = reads.findLast((one) => one.on <= read.from);
  const after = reads.find((one) => one.from >= read.on);
  return (
    (before !== undefined && before.closing !== null && before.closing === read.opening) ||
    (after !== undefined && read.closing !== null && read.closing === after.opening)
  );
};

/** Whether two accounts' statements could be one account's, had nothing kept them apart. */
type Group = Pick<Account<AccountRead>, "reads" | "digits" | "bank">;
const lookAlike = (a: Group, b: Group) => {
  const [one, other] = [a.reads[0]!, b.reads[0]!];
  return (
    one.kind === other.kind &&
    one.currency === other.currency &&
    agree(a.digits, b.digits) &&
    agree(fold(a.bank), fold(b.bank)) &&
    agree(
      a.reads.find((read) => read.accountId !== null)?.accountId ?? null,
      b.reads.find((read) => read.accountId !== null)?.accountId ?? null,
    )
  );
};

export const sameAccounts = <R extends AccountRead>(
  reads: ReadonlyArray<R>,
): ReadonlyArray<Account<R>> => {
  const groups: Array<{ reads: Array<R>; loose: boolean }> = [];
  const place = (read: R, loose: boolean) => {
    const fitting = groups.filter((group) => fits(group.reads, read));
    const chained = fitting.filter((group) => chains(group.reads, read));
    const one =
      read.digits !== null && fitting.length === 1
        ? fitting[0]
        : chained.length === 1
          ? chained[0]
          : undefined;
    if (one === undefined) groups.push({ reads: [read], loose: loose && fitting.length > 0 });
    else {
      one.reads.push(read);
      one.reads.sort(byDay);
    }
  };
  const sorted = reads.toSorted(byDay);
  for (const read of sorted) if (read.digits !== null) place(read, false);
  for (const read of sorted) if (read.digits === null) place(read, true);
  const accounts = groups.map((group) => ({
    reads: group.reads,
    digits: group.reads.find((read) => read.digits !== null)?.digits ?? null,
    bank: group.reads.findLast((read) => read.bank !== null)?.bank ?? null,
    loose: group.loose,
  }));
  return accounts.map(({ loose, ...account }, at) => ({
    ...account,
    apart:
      loose ||
      (account.digits !== null &&
        accounts.some(
          (other, index) => index !== at && other.digits !== null && lookAlike(account, other),
        )),
  }));
};

type Moved = Pick<StatementRow, "direction" | "amountMinor" | "balanceMinor">;
const signed = (kind: Statement["kind"], row: Moved) =>
  (row.direction === "credit") === (kind === "account") ? row.amountMinor : -row.amountMinor;
const byRow = (a: StatementRow, b: StatementRow) =>
  a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1;

/**
 * A statement's opening balance: printed, else its first row's balance before that row moved it.
 * `first` is that row alone, for a caller that reads no other.
 */
export const openingOf = (
  statement: Pick<Statement, "kind" | "openingMinor">,
  first: Moved | undefined,
) =>
  statement.openingMinor ??
  (first === undefined || first.balanceMinor === null
    ? null
    : first.balanceMinor - signed(statement.kind, first));

/** The day a statement's account is read from and to: its printed period, else its rows' days. */
export const periodOf = (statement: Pick<Statement, "from" | "to" | "rows">) => {
  const days = statement.rows.map((row) => row.date).toSorted();
  const ends = statement.to ?? days.at(-1) ?? null;
  const starts = statement.from ?? days[0] ?? ends;
  if (starts === null || ends === null) return undefined;
  return starts < ends ? { from: starts, on: ends } : { from: ends, on: starts };
};

export const firstRowOf = (statement: Pick<Statement, "rows">) => statement.rows.toSorted(byRow)[0];
