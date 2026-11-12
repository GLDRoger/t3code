import type {
  KinDateRow,
  KinMoney,
  KinMoneySummary,
  KinOrgId,
  KinRecordRef,
} from "@t3tools/contracts";
import { KinRecordId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { addUp, dayIn, financialYearOf, formatMoney, monthOf, shiftMonth } from "./money.ts";
import { iso, moneyDay, ownerZone, type RecordRow, selectRecords, toRecord } from "./recordRows.ts";
import { allLists, type ListDef, stateLabel } from "./registers.ts";

/**
 * Read views over every list: the dates view and the Money summary, computed from stored
 * integer amounts by code. Owner only; callers check that before calling.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATES_CAP = 200;

type DateHit = { readonly id: string; readonly kind: "due" | "date"; readonly at: number };

/** Everything due or dated in `[from, to)`, across lists, soonest first. */
export const dates = Effect.fn("KinMoneyViews.dates")(function* (
  orgId: KinOrgId,
  input: {
    readonly from: number;
    readonly to: number;
    readonly lists?: ReadonlyArray<string> | undefined;
    readonly open?: boolean | undefined;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const where = (column: "due_at" | "date_at") =>
    sql.and([
      sql`org_id = ${orgId}`,
      sql`${sql(column)} >= ${input.from}`,
      sql`${sql(column)} < ${input.to}`,
      ...(input.lists === undefined || input.lists.length === 0
        ? []
        : [sql`register_id IN ${sql.in(input.lists)}`]),
      ...(input.open === true ? [sql`state NOT IN ('done', 'dropped')`] : []),
    ]);
  const hits = sql`SELECT record_id AS id, 'due' AS kind, due_at AS at, key FROM kin_records
      WHERE ${where("due_at")}
    UNION ALL
    SELECT record_id AS id, 'date' AS kind, date_at AS at, key FROM kin_records
      WHERE ${where("date_at")}`;
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM (${hits})`;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), DATES_CAP);
  const page = yield* sql<DateHit>`SELECT id, kind, at FROM (${hits})
    ORDER BY at, key, kind LIMIT ${limit} OFFSET ${Math.max(input.offset ?? 0, 0)}`;
  const ids = [...new Set(page.map((hit) => hit.id))];
  const rows =
    ids.length === 0
      ? []
      : yield* sql<RecordRow>`${selectRecords(sql)}
          WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(ids)} ORDER BY r.record_id`;
  const byId = new Map(rows.map((row) => [row.recordId, row]));
  const lists = yield* allLists(orgId);
  return {
    total: count?.total ?? 0,
    rows: page.flatMap((hit): ReadonlyArray<KinDateRow> => {
      const row = byId.get(hit.id);
      const def = row === undefined ? undefined : lists.get(row.registerId);
      return row === undefined || def === undefined ? [] : [dateRow(row, def, hit, now)];
    }),
  };
});

const dateRow = (row: RecordRow, def: ListDef, hit: DateHit, now: number): KinDateRow => ({
  record: toRecord(row, now),
  listName: def.name,
  stateLabel: stateLabel(def, row.state),
  kind: hit.kind,
  label: hit.kind === "due" ? (def.dueLabel ?? "Due") : (def.dateLabel ?? "Date"),
  at: iso(hit.at),
  allDay: (hit.kind === "due" ? row.dueAllDay : row.dateAllDay) === 1,
});

/** The first instant of a month (`2026-11`) in `zone`. */
const monthStart = (month: string, zone: string) =>
  DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      {
        year: Number.parseInt(month.slice(0, 4), 10),
        month: Number.parseInt(month.slice(5, 7), 10),
        day: 1,
      },
      { timeZone: zone, adjustForTimeZone: true },
    ),
  );

/** The Money tab's figures: owed and overdue by client, received and spent, dates ahead, a year. */
export const moneySummary = Effect.fn("KinMoneyViews.summary")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const today = dayIn(now, zone);
  const thisMonth = monthOf(today);
  const lastMonth = shiftMonth(thisMonth, -1);
  const firstMonth = shiftMonth(thisMonth, -11);
  const financialYear = financialYearOf(today);
  const fyStart = `${financialYear.slice(2, 6)}-04-01`;
  const months = Array.from({ length: 12 }, (_, index) => shiftMonth(firstMonth, index));
  // The year's series and the financial year so far, whichever reaches further back.
  const since = `${firstMonth}-01` < fyStart ? `${firstMonth}-01` : fyStart;

  // Owed: issued invoices' balances. Payments are in the invoice's own currency.
  const invoices = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    partyId: string | null;
    partyKey: string | null;
    partyTitle: string | null;
    minor: number;
    currency: string;
    paid: number;
    dueAt: number | null;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.party_id AS "partyId",
      pa.key AS "partyKey", pa.title AS "partyTitle", r.amount_minor AS minor, r.currency,
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL) AS paid,
      r.due_at AS "dueAt"
    FROM kin_records r
    LEFT JOIN kin_records pa ON pa.org_id = r.org_id AND pa.record_id = r.party_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'invoices' AND r.state = 'waiting'
      AND r.amount_minor IS NOT NULL
    ORDER BY r.due_at, r.key`;
  const owing = invoices
    .map((invoice) => ({
      ...invoice,
      balance: { minor: invoice.minor - invoice.paid, currency: invoice.currency },
      overdue: invoice.dueAt !== null && invoice.dueAt < now,
    }))
    .filter((invoice) => invoice.balance.minor > 0);
  const clients = new Map<string | null, typeof owing>();
  for (const invoice of owing)
    clients.set(invoice.partyId, [...(clients.get(invoice.partyId) ?? []), invoice]);
  const byClient = [...clients].map(([partyId, members]) => {
    const first = members[0]!;
    const late = members.filter((one) => one.overdue);
    const oldest = Math.min(...late.map((one) => one.dueAt ?? now));
    const party: KinRecordRef | null =
      partyId === null || first.partyKey === null || first.partyTitle === null
        ? null
        : { recordId: KinRecordId.make(partyId), key: first.partyKey, title: first.partyTitle };
    return {
      party,
      owed: addUp(members.map((one) => one.balance)),
      overdue: addUp(late.map((one) => one.balance)),
      invoices: members.length,
      oldestOverdueDays: late.length === 0 ? null : Math.floor((now - oldest) / DAY_MS),
    };
  });

  // Received: payments on invoices by the day they were paid, already a day in the owner's zone.
  // Other lists paid over time are money going out.
  const payments = yield* sql<{ minor: number; currency: string; paidOn: string }>`
    SELECT p.amount_minor AS minor, p.currency, p.paid_on AS "paidOn"
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND p.voided_at IS NULL AND r.state <> 'dropped'
      AND r.register_id = 'invoices' AND p.paid_on >= ${since}
    ORDER BY p.paid_on, p.payment_id`;
  const receivedIn = (month: string) =>
    addUp(payments.filter((one) => monthOf(one.paidOn) === month));

  // Spent: paid expenses by their date, in the owner's zone.
  const expenses = yield* sql<{
    minor: number;
    currency: string;
    category: string | null;
    at: number;
  }>`SELECT r.amount_minor AS minor, r.currency, r.category, ${moneyDay(sql)} AS at
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND r.amount_minor IS NOT NULL AND ${moneyDay(sql)} >= ${monthStart(monthOf(since), zone)}
    ORDER BY at, category`;
  const spentRows = expenses.map((one) => ({ ...one, day: dayIn(one.at, zone) }));
  const spentIn = (month: string) => {
    const members = spentRows.filter((one) => monthOf(one.day) === month);
    const categories = new Map<string | null, Array<KinMoney>>();
    for (const one of members)
      categories.set(one.category, [...(categories.get(one.category) ?? []), one]);
    return {
      total: addUp(members),
      byCategory: [...categories]
        .map(([category, amounts]) => ({ category, total: addUp(amounts), count: amounts.length }))
        .toSorted(
          (a, b) =>
            (b.total[0]?.minor ?? 0) - (a.total[0]?.minor ?? 0) ||
            ((a.category ?? "") < (b.category ?? "") ? -1 : 1),
        )
        .map(({ category, total }) => ({ category, total })),
    };
  };

  const upcoming = yield* dates(
    orgId,
    { from: now, to: now + 30 * DAY_MS, open: true, limit: 50 },
    now,
  );
  return {
    asOf: iso(now),
    timeZone: zone,
    thisMonth,
    lastMonth,
    financialYear,
    owed: {
      total: addUp(owing.map((one) => one.balance)),
      overdue: addUp(owing.filter((one) => one.overdue).map((one) => one.balance)),
      invoices: owing.length,
      overdueInvoices: owing.filter((one) => one.overdue).length,
      byClient: byClient.toSorted(
        (a, b) =>
          (b.oldestOverdueDays ?? -1) - (a.oldestOverdueDays ?? -1) ||
          (b.owed[0]?.minor ?? 0) - (a.owed[0]?.minor ?? 0),
      ),
    },
    received: { thisMonth: receivedIn(thisMonth), lastMonth: receivedIn(lastMonth) },
    receivedThisFinancialYear: addUp(payments.filter((one) => one.paidOn >= fyStart)),
    spent: { thisMonth: spentIn(thisMonth), lastMonth: spentIn(lastMonth) },
    spentThisFinancialYear: addUp(spentRows.filter((one) => one.day >= fyStart)),
    upcoming: upcoming.rows,
    upcomingTotal: upcoming.total,
    series: months.map((month) => ({
      month,
      received: receivedIn(month),
      spent: spentIn(month).total,
    })),
  } satisfies KinMoneySummary;
});

const shown = (totals: ReadonlyArray<KinMoney>) =>
  totals.length === 0 ? "none" : totals.map(formatMoney).join(" + ");
const SECTION_CLIENTS = 5;
const SECTION_DATES = 10;

/**
 * The Money summary as a short block for an owner-only prompt, built by code: figures already
 * added up, so an agent quotes them and never sums. `undefined` when there is nothing to say.
 */
export const moneySection = (summary: KinMoneySummary, zone: string) => {
  const nothing =
    summary.owed.invoices === 0 &&
    summary.received.thisMonth.length === 0 &&
    summary.received.lastMonth.length === 0 &&
    summary.spent.thisMonth.total.length === 0 &&
    summary.spent.lastMonth.total.length === 0 &&
    summary.upcoming.length === 0;
  if (nothing) return undefined;
  return {
    asOf: summary.asOf,
    owedToUs: shown(summary.owed.total),
    overdue: shown(summary.owed.overdue),
    byClient: summary.owed.byClient.slice(0, SECTION_CLIENTS).map((client) => ({
      client: client.party === null ? "no client" : `${client.party.title} (${client.party.key})`,
      owed: shown(client.owed),
      ...(client.oldestOverdueDays === null
        ? {}
        : { overdue: shown(client.overdue), daysOverdue: client.oldestOverdueDays }),
    })),
    received: {
      [summary.thisMonth]: shown(summary.received.thisMonth),
      [summary.lastMonth]: shown(summary.received.lastMonth),
    },
    spent: {
      [summary.thisMonth]: shown(summary.spent.thisMonth.total),
      [summary.lastMonth]: shown(summary.spent.lastMonth.total),
    },
    topSpendThisMonth: summary.spent.thisMonth.byCategory.slice(0, 3).map((one) => ({
      category: one.category ?? "uncategorised",
      spent: shown(one.total),
    })),
    next30Days: summary.upcoming.slice(0, SECTION_DATES).map((row) => ({
      key: row.record.key,
      title: row.record.title,
      list: row.listName,
      [row.label.toLowerCase()]: row.allDay ? dayIn(Date.parse(row.at), zone) : row.at,
      ...(row.record.late ? { late: true } : {}),
    })),
    ...(summary.upcomingTotal > SECTION_DATES
      ? { moreDates: summary.upcomingTotal - SECTION_DATES }
      : {}),
  };
};
