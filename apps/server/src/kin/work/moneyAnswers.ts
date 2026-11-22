import type { KinMoney, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { homeCurrency } from "./companyProfile.ts";
import { addUp, dayIn, formatMinor, formatMoney, monthOf, shiftMonth, timeIn } from "./money.ts";
import { dates } from "./moneyViews.ts";
import { KIN_OWNER_LEVEL } from "./teamView.ts";
import {
  countedEntry,
  countedPayment,
  endOfDay,
  invoiceDue,
  moneyDay,
  ownerZone,
  repeatOf,
  startOfDay,
} from "./recordRows.ts";
import { nextDates, repeatsBetween } from "./repeat.ts";
import { alertsBeside, type AlertBalance } from "./statements/bankAlerts.ts";
import { bankKnown } from "./statements/bankKnown.ts";
import {
  type AccountRead,
  firstRowOf,
  openingOf,
  periodOf,
  sameAccounts,
} from "./statements/bankAccounts.ts";
import { findBankList } from "./statements/bankList.ts";
import { reviewOf } from "./statements/statementReview.ts";
import type { Statement } from "./statements/statementTable.ts";
import { DAY_MS } from "../durations.ts";

/**
 * The owner's money questions, answered by code from what Kin stores: cash from the statements
 * it read, what is due in and out ahead, and runway from recorded months. Every figure is exact
 * integer minor units, one per currency. Owner only; callers check that before calling.
 */

/** A closing balance older than this many days is reported as stale. */
const STALE_DAYS = 7;
const HORIZONS = [30, 60, 90] as const;
const ITEMS_SHOWN = 50;
const REPEATS_PER_ENTRY = 400;

const shift = (day: string, days: number) =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const shown = (totals: ReadonlyArray<KinMoney>) =>
  totals.length === 0 ? "none" : totals.map(formatMoney).join(" + ");

/** A statement's last stated balance and the day it stood on, if it states one. */
const closingOf = (statement: Statement) => {
  const withBalance = statement.rows
    .filter((row) => row.balanceMinor !== null)
    .toSorted((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1))
    .at(-1);
  const lastDay = statement.rows.reduce<string | null>(
    (latest, row) => (latest === null || row.date > latest ? row.date : latest),
    null,
  );
  if (statement.closingMinor !== null) {
    const on = statement.to ?? lastDay;
    return on === null ? undefined : { minor: statement.closingMinor, on };
  }
  return withBalance?.balanceMinor == null
    ? undefined
    : { minor: withBalance.balanceMinor, on: withBalance.date };
};

/** Only a statement's four digits name its account: the rest of what it says is the bank's text. */
const accountLabel = (statement: Pick<Statement, "kind" | "bank" | "account">) => {
  const digits = /^\d{4}$/.test(statement.account ?? "") ? ` ••${statement.account}` : "";
  const label = `${statement.kind === "card" ? "Card" : "Account"}${digits}`;
  return statement.bank === null ? label : `${statement.bank} ${label}`;
};

/** Money in (payments on invoices and receipts, never TDS) and spent (paid expenses), by day. */
const recordedMoney = Effect.fn("KinMoneyAnswers.recorded")(function* (
  orgId: KinOrgId,
  sinceDay: string,
  zone: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const received = yield* sql<{ minor: number; currency: string; day: string }>`
    SELECT p.amount_minor AS minor, p.currency, p.paid_on AS day
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND ${countedPayment(sql)} AND p.withheld = 0
      AND r.register_id IN ('invoices', 'receipts') AND p.paid_on >= ${sinceDay}
    ORDER BY p.paid_on, p.payment_id`;
  const spent = yield* sql<{ minor: number; currency: string; at: number }>`
    SELECT r.amount_minor AS minor, r.currency, ${moneyDay(sql)} AS at
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL
      AND ${moneyDay(sql)} >= ${startOfDay(sinceDay, zone)}
    ORDER BY at, r.key`;
  return {
    received: received.map((one) => ({ minor: one.minor, currency: one.currency, day: one.day })),
    spent: spent.map((one) => ({
      minor: one.minor,
      currency: one.currency,
      day: dayIn(one.at, zone),
    })),
  };
});

type Read = AccountRead & {
  readonly statementId: string;
  /** Everything Kin stores of an account: kind, bank, last four digits, and currency. */
  readonly identity: string;
  readonly label: string;
  readonly minor: number;
  readonly check: Statement["check"]["status"];
  /** Why it isn't a balance of record, or `undefined` when it is one. */
  readonly standing:
    | "not yet confirmed"
    | "its totals don't check out"
    | "its confirm was undone"
    | undefined;
};

/**
 * Per account (`sameAccounts`), the latest closing balance of a statement the owner confirmed
 * (not undone, check not off); newer reads beside it, never counted. Accounts Kin can't tell
 * apart are listed with no total. Records carry no account, so movements are per currency.
 */
export const cashPosition = Effect.fn("KinMoneyAnswers.cash")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const today = dayIn(now, zone);
  const stored = yield* sql<{
    statementId: string;
    reviewJson: string;
    appliedAt: number | null;
    undoneAt: number | null;
  }>`SELECT statement_id AS "statementId", review_json AS "reviewJson", applied_at AS "appliedAt",
      undone_at AS "undoneAt"
    FROM kin_bank_statements
    WHERE org_id = ${orgId} AND status = 'read' AND review_json IS NOT NULL
    ORDER BY read_at, statement_id`;
  const reads = stored.flatMap((row): ReadonlyArray<Read> => {
    const statement = reviewOf(row.reviewJson)?.statement;
    const closing = statement === undefined ? undefined : closingOf(statement);
    const period = statement === undefined ? undefined : periodOf(statement);
    if (statement === undefined || closing === undefined || period === undefined) return [];
    const digits = /^\d{4}$/.test(statement.account ?? "") ? statement.account : null;
    return [
      {
        statementId: row.statementId,
        identity: [
          statement.kind,
          (statement.bank ?? "").toLowerCase(),
          statement.account ?? "",
          statement.currency,
        ].join("\u0000"),
        label: accountLabel(statement),
        kind: statement.kind,
        bank: statement.bank,
        digits,
        accountId: statement.accountId ?? null,
        currency: statement.currency,
        from: period.from < closing.on ? period.from : closing.on,
        on: closing.on,
        opening: openingOf(statement, firstRowOf(statement)),
        closing: closing.minor,
        minor: closing.minor,
        check: statement.check.status,
        standing:
          row.appliedAt === null || row.undoneAt !== null
            ? row.undoneAt === null
              ? "not yet confirmed"
              : "its confirm was undone"
            : statement.check.status === "off"
              ? "its totals don't check out"
              : undefined,
      },
    ];
  });
  const byDay = (a: Read, b: Read) => (a.on === b.on ? 0 : a.on < b.on ? -1 : 1);
  const groups = sameAccounts(reads.filter((one) => one.standing === undefined));
  // A read not of record belongs beside the one account it could be, when there is just one.
  const candidates = (read: Read) =>
    groups.filter((group) => {
      const head = group.reads.at(-1)!;
      return (
        head.kind === read.kind &&
        head.currency === read.currency &&
        (group.digits === null || read.digits === null || group.digits === read.digits) &&
        (group.bank === null ||
          read.bank === null ||
          group.bank.toLowerCase() === read.bank.toLowerCase())
      );
    });
  // The newest read not of record per identity, unless a balance of record is as new.
  const pending = new Map<string, Read>();
  for (const read of reads.filter((one) => one.standing !== undefined).toSorted(byDay))
    if (candidates(read).every((group) => group.reads.at(-1)!.on < read.on))
      pending.set(read.identity, read);
  const statementAccounts = groups
    .map((group) => {
      const head = group.reads.at(-1)!;
      const ageDays = Math.max(daysBetween(head.on, today), 0);
      const newer = group.apart
        ? undefined
        : [...pending.values()].findLast((read) => {
            const fits = candidates(read);
            return fits.length === 1 && fits[0] === group;
          });
      return {
        ...head,
        label: accountLabel({
          kind: head.kind,
          bank: group.bank,
          account: group.digits,
        }),
        ageDays,
        stale: ageDays > STALE_DAYS,
        cannotTellApart: group.apart,
        newerRead: newer,
      };
    })
    .toSorted(
      (a, b) =>
        (a.currency === b.currency ? 0 : a.currency < b.currency ? -1 : 1) ||
        (a.label === b.label ? 0 : a.label < b.label ? -1 : 1) ||
        byDay(a, b),
    );
  const alerts = yield* alertsBeside(orgId, statementAccounts);
  const accounts = statementAccounts.map((one) => ({ ...one, alert: alerts.beside.get(one) }));
  const shownBeside = new Set(
    accounts.flatMap((one) => (one.newerRead === undefined ? [] : [one.newerRead])),
  );
  const notOfRecord = [...pending.values()]
    .filter((one) => !shownBeside.has(one))
    .toSorted((a, b) => (a.label === b.label ? byDay(a, b) : a.label < b.label ? -1 : 1));

  const held = accounts.filter((one) => one.kind === "account");
  const currencies = [...new Set(held.map((one) => one.currency))].toSorted();
  const earliest = held.map((one) => one.on).toSorted()[0];
  const recorded =
    earliest === undefined
      ? { received: [], spent: [] }
      : yield* recordedMoney(orgId, earliest, zone);
  const byCurrency = currencies.map((currency) => {
    const these = held.filter((one) => one.currency === currency);
    const since = these.map((one) => one.on).toSorted()[0]!;
    const after = (entry: { readonly day: string; readonly currency: string }) =>
      entry.currency === currency && entry.day > since;
    const received = recorded.received.filter(after).reduce((sum, e) => sum + BigInt(e.minor), 0n);
    const spent = recorded.spent.filter(after).reduce((sum, e) => sum + BigInt(e.minor), 0n);
    const withheld = these.some((one) => one.cannotTellApart);
    const total = these.reduce((sum, one) => sum + BigInt(one.minor), 0n);
    return {
      currency,
      accounts: these.length,
      total: withheld ? null : total,
      since,
      oldest: since,
      sameDay: these.every((one) => one.on === since),
      stale: these.some((one) => one.stale),
      receivedSince: received,
      spentSince: spent,
    };
  });
  return {
    asOf: now,
    today,
    timeZone: zone,
    known: accounts.length > 0,
    accounts,
    notOfRecord,
    byCurrency,
    bank: yield* bankKnown(orgId, now),
    /** Bank alert balances of accounts no confirmed statement has. */
    alertAccounts: alerts.alone,
  };
});
export type CashPosition = Effect.Success<ReturnType<typeof cashPosition>>;

/** A currency's balance now if every recorded movement since went through its accounts. */
export const cashEstimate = (one: CashPosition["byCurrency"][number]) =>
  one.total !== null && one.sameDay ? one.total + one.receivedSince - one.spentSince : null;

const alertLabel = (one: AlertBalance) => `${one.bank} ••${one.account}`;
/** An alert's balance as an agent quotes it: the bank's own mail, not a statement. */
const alertLine = (one: AlertBalance, zone: string) => ({
  availableBalance: formatMinor(BigInt(one.balanceMinor), one.currency),
  at: timeIn(one.sentAt, zone),
  source:
    "The Avl bal printed in the newest HDFC alert mail, read by code. It is the bank's figure at that moment, not a confirmed statement; totals below are from statements.",
});

const notRecordLine = (one: Read) => ({
  account: one.label,
  closingBalance: formatMinor(BigInt(one.minor), one.currency),
  on: one.on,
  standing: one.standing!,
});

/** The cash position as an agent quotes it: every figure formatted by code. */
export const cashAnswer = (cash: CashPosition) => {
  const zone = cash.timeZone;
  const notOfRecord =
    cash.notOfRecord.length === 0 ? {} : { notOfRecord: cash.notOfRecord.map(notRecordLine) };
  const fromAlerts =
    cash.alertAccounts.length === 0
      ? {}
      : {
          fromBankAlerts: cash.alertAccounts.map((one) => ({
            account: alertLabel(one),
            ...alertLine(one, zone),
          })),
        };
  if (!cash.known)
    return {
      known: false as const,
      note: "Kin has no balance of record: no bank statement the owner confirmed gives one, so the cash balance is unknown. The owner can send one in this chat and confirm it on its card.",
      ...notOfRecord,
      ...fromAlerts,
    };
  const line = (one: CashPosition["accounts"][number]) => ({
    account: one.label,
    closingBalance: formatMinor(BigInt(one.minor), one.currency),
    on: one.on,
    daysOld: one.ageDays,
    ...(one.stale ? { stale: `No statement covers the ${one.ageDays} days since ${one.on}.` } : {}),
    ...(one.check === "adds_up" ? {} : { statementCheck: one.check }),
    ...(one.cannotTellApart ? { cannotTellApart: true as const } : {}),
    ...(one.alert === undefined ? {} : { bankAlert: alertLine(one.alert, zone) }),
    ...(one.newerRead === undefined
      ? {}
      : {
          newerRead: {
            closingBalance: formatMinor(BigInt(one.newerRead.minor), one.newerRead.currency),
            on: one.newerRead.on,
            standing: one.newerRead.standing!,
          },
        }),
  });
  const cards = cash.accounts.filter((one) => one.kind === "card");
  return {
    known: true as const,
    today: cash.today,
    accounts: cash.accounts.filter((one) => one.kind === "account").map(line),
    ...(cards.length === 0 ? {} : { cardsOwed: cards.map(line) }),
    ...notOfRecord,
    ...fromAlerts,
    byCurrency: cash.byCurrency.map((one) => {
      const estimate = cashEstimate(one);
      return {
        currency: one.currency,
        accounts: one.accounts,
        ...(one.total === null
          ? {
              totalWithheld: `Kin can't tell apart balances that may be one account's, so ${one.currency} has no total. A statement that opens on another's closing balance links them.`,
            }
          : { totalOfTheseAccounts: formatMinor(one.total, one.currency) }),
        recordedSince: {
          since: one.since,
          account: "not known" as const,
          in: formatMinor(one.receivedSince, one.currency),
          out: formatMinor(one.spentSince, one.currency),
        },
        ...(estimate === null
          ? {}
          : {
              estimate: {
                now: formatMinor(estimate, one.currency),
                label: "An estimate, not a bank figure.",
                assumes: `Every payment and paid expense recorded since ${one.since} moved through ${one.accounts === 1 ? "the account" : "the accounts"} above, and the company has no other ${one.currency} account.`,
              },
            }),
      };
    }),
    basis:
      "closingBalance is the bank's own figure on that day, from a statement the owner confirmed. A read not confirmed, undone, or whose totals don't check out is never a balance. Kin's payments and expenses carry no account, so recordedSince is per currency and estimate only adds them up under the assumption it states. These are the accounts Kin has statements for, not necessarily all the company's.",
  };
};

type Expected = {
  readonly key: string;
  readonly title: string;
  readonly list: string;
  readonly at: number;
  readonly money: KinMoney;
  readonly kind: "due" | "repeat";
};

/**
 * What is expected in and out from now to `days` ahead (each of `HORIZONS` by default): issued
 * invoices by due date, with overdue ones apart and never counted as coming; open amounts we owe by
 * their due date or date, past-due ones counted as going out; and the next occurrences of entries
 * set to repeat. Then runway from the last three complete months.
 */
export const outlook = Effect.fn("KinMoneyAnswers.outlook")(function* (
  orgId: KinOrgId,
  now: number,
  days?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const home = yield* homeCurrency(orgId);
  const today = dayIn(now, zone);
  const horizons = days === undefined ? [...HORIZONS] : [days];
  const ends = horizons.map((one) => ({ days: one, end: endOfDay(shift(today, one), zone) }));
  const last = Math.max(...ends.map((one) => one.end));
  const bank = (yield* findBankList(orgId))?.id ?? "bank_transactions";
  const notOutgoing = ["invoices", "quotes", "receipts", "clients", "contacts", "projects", bank];

  const invoices = yield* sql<{
    key: string;
    title: string;
    minor: number;
    currency: string;
    paid: number;
    dueAt: number | null;
  }>`SELECT r.key, r.title, r.amount_minor AS minor, r.currency, ${invoiceDue(sql)} AS "dueAt",
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL) AS paid
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'invoices' AND r.state = 'waiting'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL
    ORDER BY r.due_at, r.key`;
  const open = invoices
    .map((one) => ({ ...one, balance: one.minor - one.paid }))
    .filter((one) => one.balance > 0);
  const incoming: Array<Expected> = open.flatMap((one) =>
    one.dueAt !== null && one.dueAt >= now && one.dueAt <= last
      ? [
          {
            key: one.key,
            title: one.title,
            list: "Invoices",
            at: one.dueAt,
            money: { minor: one.balance, currency: one.currency },
            kind: "due" as const,
          },
        ]
      : [],
  );
  const overdueIn = open.filter((one) => one.dueAt !== null && one.dueAt < now);
  const undatedIn = open.filter((one) => one.dueAt === null);
  const laterIn = open.filter((one) => one.dueAt !== null && one.dueAt > last);

  const owed = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    list: string;
    minor: number;
    currency: string;
    paid: number;
    at: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, g.name AS list, r.amount_minor AS minor,
      r.currency, COALESCE(r.due_at, r.date_at) AS at,
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL) AS paid
    FROM kin_records r
    JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id
    WHERE r.org_id = ${orgId} AND r.amount_minor IS NOT NULL AND ${countedEntry(sql)}
      AND r.state <> 'done' AND COALESCE(r.side, 'ours') <> 'theirs'
      AND r.register_id NOT IN ${sql.in(notOutgoing)}
      AND COALESCE(r.due_at, r.date_at) IS NOT NULL AND COALESCE(r.due_at, r.date_at) <= ${last}
    ORDER BY at, r.key`;
  const outgoing: Array<Expected> = owed
    .filter((one) => one.minor - one.paid > 0)
    .map((one) => ({
      key: one.key,
      title: one.title,
      list: one.list,
      at: one.at,
      money: { minor: one.minor - one.paid, currency: one.currency },
      kind: "due" as const,
    }));

  // The newest entry of each repeating series: nothing was made from it yet.
  const heads = yield* sql<{
    key: string;
    title: string;
    list: string;
    minor: number;
    currency: string;
    dueAt: number | null;
    dueAllDay: number;
    dateAt: number | null;
    dateAllDay: number;
    repeatJson: string;
  }>`SELECT r.key, r.title, g.name AS list, r.amount_minor AS minor, r.currency,
      r.due_at AS "dueAt", r.due_all_day AS "dueAllDay", r.date_at AS "dateAt",
      r.date_all_day AS "dateAllDay", r.repeat_json AS "repeatJson"
    FROM kin_records r
    JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id
    WHERE r.org_id = ${orgId} AND r.repeat_json IS NOT NULL AND r.amount_minor IS NOT NULL
      AND ${countedEntry(sql)} AND COALESCE(r.side, 'ours') <> 'theirs'
      AND r.register_id NOT IN ${sql.in(notOutgoing)}
      AND NOT EXISTS (SELECT 1 FROM kin_records n WHERE n.org_id = r.org_id
        AND n.origin_key = 'repeat:' || r.record_id)
    ORDER BY r.key`;
  const incomplete: Array<string> = [];
  for (const head of heads) {
    const repeat = repeatOf(head.repeatJson);
    if (repeat === undefined) continue;
    const start = {
      dueAt: head.dueAt,
      dueAllDay: head.dueAllDay === 1,
      dateAt: head.dateAt,
      dateAllDay: head.dateAllDay === 1,
    };
    const startAt = start.dueAt ?? start.dateAt;
    // Repeats already past are skipped in one step, so the cap only counts the ones ahead.
    const skipped = startAt === null ? 0 : repeatsBetween(repeat.rule, startAt, now);
    const current =
      skipped === 0 ? start : { ...start, ...nextDates(repeat, start, zone, skipped) };
    let ended = false;
    for (let step = 0; step < REPEATS_PER_ENTRY; step += 1) {
      const next = nextDates(repeat, current, zone);
      const at = next.dueAt ?? next.dateAt;
      if (at === null || at > last) {
        ended = true;
        break;
      }
      Object.assign(current, next);
      if (at < now) continue;
      outgoing.push({
        key: head.key,
        title: head.title,
        list: head.list,
        at,
        money: { minor: head.minor, currency: head.currency },
        kind: "repeat",
      });
    }
    if (!ended) incomplete.push(head.key);
  }
  outgoing.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  const dueOut = outgoing.filter((one) => one.at >= now);
  const overdueOut = outgoing.filter((one) => one.at < now);
  const undated = yield* dates(
    orgId,
    { from: now, to: last + 1, lists: ["dates"], open: true, limit: 10, viewer: KIN_OWNER_LEVEL },
    now,
  );

  const windows = ends.map(({ days: span, end }) => {
    const inWindow = (one: Expected) => one.at <= end;
    const expectedIn = addUp(
      incoming.filter(inWindow).map((one) => one.money),
      home,
    );
    const expectedOut = addUp(
      [...overdueOut.map((one) => one.money), ...dueOut.filter(inWindow).map((one) => one.money)],
      home,
    );
    const currencies = [...new Set([...expectedIn, ...expectedOut].map((one) => one.currency))];
    return {
      days: span,
      through: dayIn(end, zone),
      expectedIn,
      expectedOut,
      net: currencies.map((currency) => ({
        currency,
        minor:
          BigInt(expectedIn.find((one) => one.currency === currency)?.minor ?? 0) -
          BigInt(expectedOut.find((one) => one.currency === currency)?.minor ?? 0),
      })),
    };
  });
  return {
    today,
    timeZone: zone,
    windows,
    incoming,
    overdueIn: overdueIn.map((one) => ({
      key: one.key,
      title: one.title,
      dueAt: one.dueAt ?? 0,
      money: { minor: one.balance, currency: one.currency },
    })),
    undatedIn: addUp(
      undatedIn.map((one) => ({ minor: one.balance, currency: one.currency })),
      home,
    ),
    laterIn: addUp(
      laterIn.map((one) => ({ minor: one.balance, currency: one.currency })),
      home,
    ),
    dueOut,
    overdueOut,
    datesWithoutAmount: undated.rows,
    incomplete,
    runway: yield* runway(orgId, now, zone, today),
  };
});
export type Outlook = Effect.Success<ReturnType<typeof outlook>>;

/**
 * Runway per currency: the cash of record divided by the average monthly net outflow of the last
 * three complete months in the owner's zone. No number without a total balance of record, unless
 * that currency's eligible history (counted as cash is: no TDS, no void invoices) starts by the
 * first day of those months, or when the months netted money in.
 */
const runway = Effect.fn("KinMoneyAnswers.runway")(function* (
  orgId: KinOrgId,
  now: number,
  zone: string,
  today: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const thisMonth = monthOf(today);
  const months = [-3, -2, -1].map((back) => shiftMonth(thisMonth, back));
  const first = `${months[0]!}-01`;
  const recorded = yield* recordedMoney(orgId, first, zone);
  const inWindow = (one: { readonly day: string }) => one.day < `${thisMonth}-01`;
  const paidFirst = yield* sql<{ currency: string; day: string }>`SELECT p.currency,
      MIN(p.paid_on) AS day
    FROM kin_record_payments p JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND ${countedPayment(sql)} AND p.withheld = 0
      AND r.register_id IN ('invoices', 'receipts')
    GROUP BY p.currency ORDER BY p.currency`;
  const spentFirst = yield* sql<{ currency: string; at: number }>`SELECT r.currency,
      MIN(${moneyDay(sql)}) AS at
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'expenses'
      AND r.state = 'done' AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL
    GROUP BY r.currency ORDER BY r.currency`;
  const sinceOf = (currency: string) =>
    [
      ...paidFirst.filter((one) => one.currency === currency).map((one) => one.day),
      ...spentFirst.filter((one) => one.currency === currency).map((one) => dayIn(one.at, zone)),
    ].toSorted()[0];
  const cash = yield* cashPosition(orgId, now);
  const currencies = [
    ...new Set([
      ...cash.byCurrency.map((one) => one.currency),
      ...recorded.received.filter(inWindow).map((one) => one.currency),
      ...recorded.spent.filter(inWindow).map((one) => one.currency),
    ]),
  ].toSorted();
  return currencies.map((currency) => {
    const total = (
      rows: ReadonlyArray<{ minor: number; currency: string; day: string }>,
      month: string,
    ) =>
      rows
        .filter((one) => one.currency === currency && monthOf(one.day) === month)
        .reduce((sum, one) => sum + BigInt(one.minor), 0n);
    const perMonth = months.map((month) => {
      const received = total(recorded.received, month);
      const spent = total(recorded.spent, month);
      return { month, received, spent, net: received - spent };
    });
    const averageNet = perMonth.reduce((sum, one) => sum + one.net, 0n) / 3n;
    const held = cash.byCurrency.find((one) => one.currency === currency);
    const balance =
      held === undefined || held.total === null
        ? null
        : { minor: held.total, oldest: held.oldest, stale: held.stale, accounts: held.accounts };
    const since = sinceOf(currency);
    const enough = since !== undefined && since <= first;
    const months10 =
      balance === null || !enough || averageNet >= 0n
        ? null
        : balance.minor <= 0n
          ? 0n
          : (balance.minor * 10n) / -averageNet;
    return {
      currency,
      months: perMonth,
      averageNet,
      balance,
      withheld: held !== undefined && held.total === null,
      enoughHistory: enough,
      historySince: since ?? null,
      runwayTenths: months10,
    };
  });
});

const itemsShown = (items: ReadonlyArray<Expected>, zone: string) =>
  items.slice(0, ITEMS_SHOWN).map((one) => ({
    key: one.key,
    title: one.title,
    list: one.list,
    on: dayIn(one.at, zone),
    amount: formatMoney(one.money),
    ...(one.kind === "repeat" ? { repeats: true as const } : {}),
  }));

/** The outlook as an agent quotes it, inputs included so it can say how a figure was reached. */
export const outlookAnswer = (view: Outlook) => ({
  today: view.today,
  windows: view.windows.map((one) => ({
    days: one.days,
    through: one.through,
    expectedIn: shown(one.expectedIn),
    expectedOut: shown(one.expectedOut),
    net:
      one.net.length === 0
        ? "none"
        : one.net.map((n) => formatMinor(n.minor, n.currency)).join(" + "),
  })),
  comingIn: itemsShown(view.incoming, view.timeZone),
  ...(view.incoming.length > ITEMS_SHOWN
    ? { moreComingIn: view.incoming.length - ITEMS_SHOWN }
    : {}),
  overdueNotCounted: view.overdueIn.slice(0, ITEMS_SHOWN).map((one) => ({
    key: one.key,
    title: one.title,
    due: dayIn(one.dueAt, view.timeZone),
    balance: formatMoney(one.money),
  })),
  ...(view.undatedIn.length === 0 ? {} : { owedWithNoDueDate: shown(view.undatedIn) }),
  ...(view.laterIn.length === 0 ? {} : { owedDueLater: shown(view.laterIn) }),
  goingOut: itemsShown(view.dueOut, view.timeZone),
  ...(view.dueOut.length > ITEMS_SHOWN ? { moreGoingOut: view.dueOut.length - ITEMS_SHOWN } : {}),
  ...(view.overdueOut.length === 0
    ? {}
    : { pastDueCountedAsGoingOut: itemsShown(view.overdueOut, view.timeZone) }),
  ...(view.incomplete.length === 0
    ? {}
    : {
        incomplete: `Expected out is short: ${view.incomplete.join(", ")} repeat${view.incomplete.length === 1 ? "s" : ""} more often than Kin projects ahead (${REPEATS_PER_ENTRY} dates each), so later dates aren't counted.`,
      }),
  ...(view.datesWithoutAmount.length === 0
    ? {}
    : {
        datesWithNoAmount: view.datesWithoutAmount.map((row) => ({
          key: row.record.key,
          title: row.record.title,
          on: row.allDay ? dayIn(Date.parse(row.at), view.timeZone) : row.at,
        })),
      }),
  runway: view.runway.map((one) => ({
    currency: one.currency,
    lastThreeMonths: one.months.map((month) => ({
      month: month.month,
      in: formatMinor(month.received, one.currency),
      out: formatMinor(month.spent, one.currency),
      net: formatMinor(month.net, one.currency),
    })),
    averageMonthlyNet: formatMinor(one.averageNet, one.currency),
    ...(one.balance === null
      ? {}
      : {
          cash: formatMinor(one.balance.minor, one.currency),
          cashAsOf: one.balance.oldest,
          ...(one.balance.stale ? { cashStale: true as const } : {}),
        }),
    ...(one.runwayTenths === null
      ? {
          runwayMonths: null,
          why:
            one.balance === null
              ? one.withheld
                ? "Kin can't tell this currency's accounts apart, so it has no total cash to divide."
                : "No confirmed bank statement gives a balance in this currency."
              : !one.enoughHistory
                ? `Kin's records in ${one.currency} start ${one.historySince ?? "nowhere"}: not three complete months from ${one.months[0]!.month}-01 yet.`
                : "These months brought in at least what went out, so cash isn't running down.",
        }
      : {
          runwayMonths: `${one.runwayTenths / 10n}.${one.runwayTenths % 10n}`,
        }),
  })),
  basis:
    "Expected in is issued invoices' unpaid balances by due date; overdue ones are listed, never counted. Expected out is open amounts we owe by due date, past-due ones counted, and the next dates of entries set to repeat. Runway is cash divided by the average monthly net of the last three complete months, from payments and paid expenses recorded in Kin; TDS is never cash.",
});
