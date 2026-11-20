import type { KinBankKnown, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { formatMinor } from "../money.ts";

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
 * provider says it is complete to. Its lines would replace that account's alerts in the span the
 * same way a statement's do (`alertLines.ts`), so alerts stay the reach past the last pull.
 */
export interface BankCoverage {
  /** The account as Kin tells it apart: bank, last four digits and currency. */
  readonly account: string;
  readonly label: string;
  readonly currency: string;
  readonly from: string;
  readonly through: string;
  /** Its last four digits, which a bank alert names; its closing balance on `through`. */
  readonly digits?: string | null;
  readonly closingMinor?: number | null;
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
  readonly digits?: string | null;
  /** The last day any confirmed statement of it covers, and its closing balance when that one ends the run. */
  readonly lastEnd?: string;
  readonly closingMinor?: number | null;
}

/**
 * What the owner's bank alerts add to one account since its statements: never complete (banks
 * skip some, people filter them), so a second reach beside `through`, which they never move.
 */
export interface BankAlertReach {
  readonly account: string;
  readonly digits: string;
  readonly currency: string;
  /** The statements' day for this account the alerts count after; null with no statement. */
  readonly since: string | null;
  /** The newest counted alert's day. */
  readonly seenThrough: string;
  readonly in: number;
  readonly out: number;
  /** The newest alert's own stated balance, else the last closing balance plus and minus the alerts since. */
  readonly balance?: { readonly minor: number; readonly on: string; readonly estimate: boolean };
}

export interface BankKnown extends Omit<KinBankKnown, "alerts"> {
  readonly accounts: ReadonlyArray<BankAccountKnown>;
  readonly alerts: ReadonlyArray<BankAlertReach>;
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
    const last = sorted.reduce((latest, span) => (span.through > latest.through ? span : latest));
    return {
      account: first.account,
      label: first.label,
      currency: first.currency,
      from: first.from,
      through,
      ...(first.digits === undefined ? {} : { digits: first.digits }),
      lastEnd: last.through,
      ...(last.through === through && last.closingMinor !== undefined
        ? { closingMinor: last.closingMinor }
        : {}),
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
  return { through, accounts, alerts: [] };
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
    closing: number | null;
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
          FROM json_each(s.review_json, '$.statement.rows') j) END AS last,
      COALESCE(json_extract(s.review_json, '$.statement.closingMinor'),
        (SELECT json_extract(j.value, '$.balanceMinor')
          FROM json_each(s.review_json, '$.statement.rows') j
          WHERE json_extract(j.value, '$.balanceMinor') IS NOT NULL
          ORDER BY json_extract(j.value, '$.date') DESC, CAST(j.key AS INTEGER) DESC
          LIMIT 1)) AS closing
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
        digits,
        closingMinor: typeof row.closing === "number" ? row.closing : null,
      },
    ];
  });
});

/**
 * Counted bank alerts per account, after the day its statements reach. Only alerts of senders
 * still counted; one currency each, never summed across.
 */
const alertReach = (
  accounts: ReadonlyArray<BankAccountKnown>,
  alerts: ReadonlyArray<{
    readonly account: string;
    readonly currency: string;
    readonly direction: "credit" | "debit";
    readonly amountMinor: number;
    readonly day: string;
    readonly balanceMinor: number | null;
  }>,
): ReadonlyArray<BankAlertReach> => {
  const groups = new Map<string, Array<(typeof alerts)[number]>>();
  for (const alert of alerts) {
    const key = `${alert.account}\u0000${alert.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), alert]);
  }
  return [...groups.values()].flatMap((group): ReadonlyArray<BankAlertReach> => {
    const { account: digits, currency } = group[0]!;
    const known = accounts.filter((one) => one.digits === digits && one.currency === currency);
    const statement = known.length === 1 ? known[0] : undefined;
    const since =
      known.length === 0
        ? null
        : known.reduce((latest, one) => (one.through > latest ? one.through : latest), "");
    const after = group.filter((one) => since === null || one.day > since);
    const newest = after.at(-1);
    if (newest === undefined) return [];
    const credits = after.filter((one) => one.direction === "credit");
    const moved = after.reduce(
      (sum, one) => sum + (one.direction === "credit" ? one.amountMinor : -one.amountMinor),
      0,
    );
    const balance =
      newest.balanceMinor !== null
        ? { minor: newest.balanceMinor, on: newest.day, estimate: false }
        : statement?.closingMinor != null && Number.isSafeInteger(statement.closingMinor + moved)
          ? { minor: statement.closingMinor + moved, on: newest.day, estimate: true }
          : undefined;
    return [
      {
        account: statement?.label ?? `Account ••${digits}`,
        digits,
        currency,
        since,
        seenThrough: newest.day,
        in: credits.length,
        out: after.length - credits.length,
        ...(balance === undefined ? {} : { balance }),
      },
    ];
  });
};

/** The one read every money surface uses: how far Kin sees the bank now. */
export const bankKnown = Effect.fn("KinBankKnown.read")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const known = knownThrough(yield* confirmedCoverage(orgId));
  const alerts = yield* sql<{
    account: string;
    currency: string;
    direction: "credit" | "debit";
    amountMinor: number;
    day: string;
    balanceMinor: number | null;
  }>`SELECT a.account, a.currency, a.direction, a.amount_minor AS "amountMinor", a.day,
      a.balance_minor AS "balanceMinor"
    FROM kin_bank_alerts a
    JOIN kin_bank_alert_senders s ON s.org_id = a.org_id AND s.connection_id = a.connection_id
      AND s.address = a.address AND s.account = a.account
    WHERE a.org_id = ${orgId} AND a.state = 'counted' AND s.state = 'counted'
    ORDER BY a.account, a.currency, a.day, a.received_at, a.alert_id`;
  return { ...known, alerts: alertReach(known.accounts, alerts) };
});

/** `bankAnswer` in a tool's result. */
export const BankAnswer = Schema.Struct({
  knownThrough: Schema.NullOr(Schema.String),
  note: Schema.String,
  accounts: Schema.optional(Schema.Unknown),
  alerts: Schema.optional(Schema.Unknown),
  alertsNote: Schema.optional(Schema.String),
});

/** Where a turn's outside text came from when it read a bank alert. */
export const ALERT_SOURCE = "bank alert";
/** An invoice's matched alert, as an agent reads it. */
export const INVOICE_ALERT_NOTE =
  "A bank alert, the bank's own mail, shows this money coming in. It is not recorded as paid: Kin's own card asks the owner, and only their tap records it.";
/** What a bank alert is and is not, beside every answer that carries one. */
const ALERTS_NOTE =
  "Bank alerts are the bank's own mails, read by Kin only from senders the owner confirmed and only when the mail passed its sender checks. Banks skip some and people filter them, so they never move knownThrough, and their counts and balance are not a bank figure. An alert records nothing as paid: only the owner's tap on Kin's card does.";

/**
 * How far Kin sees the bank, as an agent reads it beside a money answer; `accounts` adds each
 * account's run. Every word is the server's.
 */
export const bankAnswer = (bank: BankKnown, accounts = false, alerts = true) => ({
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
  ...(alerts && bank.alerts.length > 0
    ? {
        alerts: bank.alerts.map((one) => ({
          account: one.account,
          ...(one.since === null ? {} : { since: one.since }),
          seenThrough: one.seenThrough,
          in: one.in,
          out: one.out,
          ...(one.balance === undefined
            ? {}
            : {
                balance: formatMinor(BigInt(one.balance.minor), one.currency),
                balanceOn: one.balance.on,
                balanceIs: one.balance.estimate
                  ? "an estimate: the last confirmed statement's closing balance plus and minus the alerts since"
                  : "as the bank's newest alert states it",
              }),
        })),
        alertsNote: ALERTS_NOTE,
      }
    : {}),
});
