import type { KinBankKnown, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { dayIn } from "../money.ts";
import { ownerZone } from "../recordRows.ts";
import { openingOf, sameAccounts } from "./bankAccounts.ts";
import { DAY_MS } from "../../durations.ts";

/**
 * How far Kin sees the bank, computed when read from the statements the owner confirmed. Kin
 * sees a bank account only through its lines; whatever reached it after the last of them, or in
 * a month no statement covers, Kin can't tell.
 */

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
  /** The account as `sameAccounts` tells it apart. */
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
 * following the run's end is a gap, and the run stops before it. No day counts past `today`. For
 * the company, the earliest end among accounts kept up; with no coverage at all, null.
 */
export const knownThrough = (coverage: ReadonlyArray<BankCoverage>, today: string): BankKnown => {
  const byAccount = new Map<string, Array<BankCoverage>>();
  for (const span of coverage) {
    if (span.from > today) continue;
    const seen = { ...span, through: span.through > today ? today : span.through };
    const spans = byAccount.get(span.account);
    if (spans === undefined) byAccount.set(span.account, [seen]);
    else spans.push(seen);
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
const RowJson = Schema.fromJsonString(
  Schema.Struct({
    index: Schema.Number,
    date: Schema.String,
    direction: Schema.Literals(["debit", "credit"]),
    amountMinor: Schema.Number,
    balanceMinor: Schema.NullOr(Schema.Number),
  }),
);
const decodeRow = Schema.decodeUnknownOption(RowJson);

/**
 * Coverage from the bank-account statements the owner confirmed and has not undone, one account
 * per `sameAccounts`. A statement whose totals don't check out still counts: its lines were
 * confirmed. Cards never receive what clients pay, so they cover nothing here.
 */
const confirmedCoverage = Effect.fn("KinBankKnown.coverage")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    bank: string | null;
    digits: string | null;
    accountId: string | null;
    currency: string | null;
    from: string | null;
    to: string | null;
    first: string | null;
    last: string | null;
    opening: number | null;
    closing: number | null;
    firstRow: string | null;
    lastBalance: number | null;
  }>`SELECT json_extract(s.review_json, '$.statement.bank') AS bank,
      json_extract(s.review_json, '$.statement.account') AS digits,
      json_extract(s.review_json, '$.statement.accountId') AS "accountId",
      json_extract(s.review_json, '$.statement.currency') AS currency,
      json_extract(s.review_json, '$.statement.from') AS "from",
      json_extract(s.review_json, '$.statement.to') AS "to",
      CASE WHEN json_extract(s.review_json, '$.statement.from') IS NULL
        THEN (SELECT MIN(json_extract(j.value, '$.date'))
          FROM json_each(s.review_json, '$.statement.rows') j) END AS first,
      CASE WHEN json_extract(s.review_json, '$.statement.to') IS NULL
        THEN (SELECT MAX(json_extract(j.value, '$.date'))
          FROM json_each(s.review_json, '$.statement.rows') j) END AS last,
      json_extract(s.review_json, '$.statement.openingMinor') AS opening,
      json_extract(s.review_json, '$.statement.closingMinor') AS closing,
      CASE WHEN json_extract(s.review_json, '$.statement.openingMinor') IS NULL
        THEN (SELECT j.value FROM json_each(s.review_json, '$.statement.rows') j
          ORDER BY json_extract(j.value, '$.date'), json_extract(j.value, '$.index') LIMIT 1)
        END AS "firstRow",
      CASE WHEN json_extract(s.review_json, '$.statement.closingMinor') IS NULL
        THEN (SELECT json_extract(j.value, '$.balanceMinor')
          FROM json_each(s.review_json, '$.statement.rows') j
          WHERE json_extract(j.value, '$.balanceMinor') IS NOT NULL
          ORDER BY json_extract(j.value, '$.date') DESC, json_extract(j.value, '$.index') DESC
          LIMIT 1) END AS "lastBalance"
    FROM kin_bank_statements s
    WHERE s.org_id = ${orgId} AND s.status = 'read' AND s.review_json IS NOT NULL
      AND json_valid(s.review_json) AND s.applied_at IS NOT NULL AND s.undone_at IS NULL
      AND json_extract(s.review_json, '$.statement.kind') = 'account'
    ORDER BY s.applied_at, s.statement_id`;
  const reads = rows.flatMap((row) => {
    const ends = dayOr(row.to) ?? dayOr(row.last);
    const starts = dayOr(row.from) ?? dayOr(row.first) ?? ends;
    if (starts === null || ends === null || row.currency === null) return [];
    const first =
      row.firstRow === null ? undefined : Option.getOrUndefined(decodeRow(row.firstRow));
    return [
      {
        kind: "account" as const,
        bank: row.bank,
        digits: row.digits !== null && /^\d{4}$/.test(row.digits) ? row.digits : null,
        accountId: row.accountId,
        currency: row.currency,
        from: starts < ends ? starts : ends,
        on: starts < ends ? ends : starts,
        opening: openingOf({ kind: "account", openingMinor: row.opening }, first),
        closing: row.closing ?? row.lastBalance,
      },
    ];
  });
  return sameAccounts(reads).flatMap((account, at): ReadonlyArray<BankCoverage> => {
    const label = `${account.bank === null ? "" : `${account.bank} `}Account${account.digits === null ? "" : ` ••${account.digits}`}`;
    return account.reads.map((read) => ({
      account: `${at}`,
      label,
      currency: read.currency,
      from: read.from,
      through: read.on,
    }));
  });
});

/**
 * The one read every money surface uses: how far Kin sees the bank at `at` (now, unless given),
 * never past that day in the owner's zone.
 */
export const bankKnown = Effect.fn("KinBankKnown.read")(function* (orgId: KinOrgId, at?: number) {
  const today = dayIn(at ?? (yield* Clock.currentTimeMillis), yield* ownerZone(orgId));
  return knownThrough(yield* confirmedCoverage(orgId), today);
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
