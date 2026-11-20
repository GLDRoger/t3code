import type { KinBankKnown, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * How far Kin sees the bank, computed when read from the statements the owner confirmed. Kin
 * sees a bank account only through its lines; whatever reached it after the last of them, or in
 * a month no statement covers, Kin can't tell.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** An account whose lines end this long before another's no longer holds back the company's day. */
const KEPT_UP_DAYS = 45;

const nextDay = (day: string) =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(Date.parse(`${day}T00:00:00Z`) + DAY_MS));
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Days of one bank account whose every line Kin holds: a confirmed statement's period. A live
 * feed would add its own pulls here, `from` its first day asked and `through` the day its
 * provider says it is complete to.
 */
export interface BankCoverage {
  /** The account as Kin tells it apart: bank, last four digits and currency. */
  readonly account: string;
  readonly label: string;
  readonly currency: string;
  readonly from: string;
  readonly through: string;
}

export interface BankAccountKnown {
  readonly account: string;
  readonly label: string;
  readonly currency: string;
  /** The first day of the run, and its last: every line between is Kin's. */
  readonly from: string;
  readonly through: string;
  /** Its lines end within `KEPT_UP_DAYS` of the newest account's: it counts for the company. */
  readonly keptUp: boolean;
}

export interface BankKnown extends KinBankKnown {
  readonly accounts: ReadonlyArray<BankAccountKnown>;
}

/**
 * Per account, the unbroken run of covered days from its first: a span that starts after the day
 * following the run's end is a gap, and the run stops before it. For the company, the earliest
 * end among accounts kept up; with no coverage at all, null.
 */
export const knownThrough = (coverage: ReadonlyArray<BankCoverage>): BankKnown => {
  const byAccount = new Map<string, Array<BankCoverage>>();
  for (const span of coverage) {
    const spans = byAccount.get(span.account);
    if (spans === undefined) byAccount.set(span.account, [span]);
    else spans.push(span);
  }
  const runs = [...byAccount.values()].map((spans) => {
    const sorted = spans.toSorted((a, b) =>
      `${a.from}${a.through}` < `${b.from}${b.through}` ? -1 : 1,
    );
    const first = sorted[0]!;
    let through = first.through;
    for (const span of sorted.slice(1)) {
      if (span.from > nextDay(through)) break;
      if (span.through > through) through = span.through;
    }
    return {
      account: first.account,
      label: first.label,
      currency: first.currency,
      from: first.from,
      through,
    };
  });
  const newest = runs.reduce<string | null>(
    (latest, run) => (latest === null || run.through > latest ? run.through : latest),
    null,
  );
  const accounts = runs
    .map((run) => ({
      ...run,
      keptUp: newest !== null && daysBetween(run.through, newest) <= KEPT_UP_DAYS,
    }))
    .toSorted((a, b) =>
      a.label === b.label ? (a.account < b.account ? -1 : 1) : a.label < b.label ? -1 : 1,
    );
  const through = accounts
    .filter((one) => one.keptUp)
    .reduce<string | null>(
      (earliest, one) => (earliest === null || one.through < earliest ? one.through : earliest),
      null,
    );
  return { through, accounts };
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOr = (value: string | null) => (value !== null && DAY.test(value) ? value : null);

/**
 * Coverage from the bank-account statements the owner confirmed and has not undone. A statement
 * whose totals don't check out still counts: its lines were confirmed. Cards never receive what
 * clients pay, so they cover nothing here.
 */
const confirmedCoverage = Effect.fn("KinBankKnown.coverage")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    bank: string | null;
    digits: string | null;
    currency: string | null;
    from: string | null;
    to: string | null;
    first: string | null;
    last: string | null;
  }>`SELECT json_extract(s.review_json, '$.statement.bank') AS bank,
      json_extract(s.review_json, '$.statement.account') AS digits,
      json_extract(s.review_json, '$.statement.currency') AS currency,
      json_extract(s.review_json, '$.statement.from') AS "from",
      json_extract(s.review_json, '$.statement.to') AS "to",
      CASE WHEN json_extract(s.review_json, '$.statement.from') IS NULL
        THEN (SELECT MIN(json_extract(j.value, '$.date'))
          FROM json_each(s.review_json, '$.statement.rows') j) END AS first,
      CASE WHEN json_extract(s.review_json, '$.statement.to') IS NULL
        THEN (SELECT MAX(json_extract(j.value, '$.date'))
          FROM json_each(s.review_json, '$.statement.rows') j) END AS last
    FROM kin_bank_statements s
    WHERE s.org_id = ${orgId} AND s.status = 'read' AND s.review_json IS NOT NULL
      AND json_valid(s.review_json) AND s.applied_at IS NOT NULL AND s.undone_at IS NULL
      AND json_extract(s.review_json, '$.statement.kind') = 'account'
    ORDER BY s.applied_at, s.statement_id`;
  return rows.flatMap((row): ReadonlyArray<BankCoverage> => {
    const ends = dayOr(row.to) ?? dayOr(row.last);
    const starts = dayOr(row.from) ?? dayOr(row.first) ?? ends;
    if (starts === null || ends === null || row.currency === null) return [];
    const digits = row.digits !== null && /^\d{4}$/.test(row.digits) ? row.digits : null;
    const label = `${row.bank === null ? "" : `${row.bank} `}Account${digits === null ? "" : ` ••${digits}`}`;
    return [
      {
        account: [(row.bank ?? "").toLowerCase(), digits ?? "", row.currency].join("\u0000"),
        label,
        currency: row.currency,
        from: starts < ends ? starts : ends,
        through: starts < ends ? ends : starts,
      },
    ];
  });
});

/** The one read every money surface uses: how far Kin sees the bank now. */
export const bankKnown = Effect.fn("KinBankKnown.read")(function* (orgId: KinOrgId) {
  return knownThrough(yield* confirmedCoverage(orgId));
});

/** `bankAnswer` in a tool's result. */
export const BankAnswer = Schema.Struct({
  knownThrough: Schema.NullOr(Schema.String),
  note: Schema.String,
  accounts: Schema.optional(Schema.Unknown),
});

/**
 * How far Kin sees the bank, as an agent reads it beside a money answer; `accounts` adds each
 * account's run. Every word is the server's.
 */
export const bankAnswer = (bank: BankKnown, accounts = false) => ({
  knownThrough: bank.through,
  note:
    bank.through === null
      ? "No bank statement is confirmed, so Kin can't see what reached the bank."
      : `The confirmed bank statements cover every day to ${bank.through} on the accounts Kin has; Kin can't see the bank after that day.`,
  ...(accounts && bank.accounts.length > 0
    ? {
        accounts: bank.accounts.map((one) => ({
          account: one.label,
          from: one.from,
          knownThrough: one.through,
          ...(one.keptUp ? {} : { keptUp: false as const }),
        })),
      }
    : {}),
});
