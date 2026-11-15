import type {
  KinDateRow,
  KinMoney,
  KinMoneySummary,
  KinOrgId,
  KinPersonId,
  KinRecordRef,
} from "@t3tools/contracts";
import { KinRecordId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { addUp, dayIn, financialYearOf, formatMoney, monthOf, shiftMonth } from "./money.ts";
import {
  countedEntry,
  fieldDateAt,
  countedPayment,
  iso,
  moneyDay,
  owedInvoices,
  ownerZone,
  type RecordRow,
  selectRecords,
  toRecord,
} from "./recordRows.ts";
import { parseFields } from "./lists.ts";
import { allLists, isFieldDate, type ListDef, stateLabel } from "./registers.ts";
import { viewSees } from "./teamView.ts";

/**
 * Read views over every list: the dates view and the Money summary, computed from stored
 * integer amounts by code. Whole for the owner; for anyone else, of what `personSees` gives them.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATES_CAP = 200;

type DateHit = {
  readonly id: string;
  readonly key: string;
  readonly kind: "due" | "date";
  readonly at: number;
  readonly field?: { readonly key: string; readonly label: string; readonly allDay: boolean };
};
const order = (a: DateHit, b: DateHit) =>
  a.at - b.at ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
  (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
  (a.field?.key ?? "").localeCompare(b.field?.key ?? "");

/** The lists' own date fields with a value in `[from, to)`, read from each entry's fields. */
const fieldHits = Effect.fn("KinMoneyViews.fieldHits")(function* (
  orgId: KinOrgId,
  lists: ReadonlyMap<string, ListDef>,
  input: {
    readonly from: number;
    readonly to: number;
    readonly lists?: ReadonlyArray<string> | undefined;
    readonly open?: boolean | undefined;
    readonly view?: ReadonlyArray<KinPersonId> | undefined;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const asked = input.lists === undefined || input.lists.length === 0 ? undefined : input.lists;
  const hits: Array<DateHit> = [];
  // By text first, a day either side, so the zone's exact edges are settled below.
  const fromDay = dayIn(input.from - DAY_MS, zone);
  const toDay = dayIn(input.to + DAY_MS, zone);
  for (const def of lists.values()) {
    if (asked !== undefined && !asked.includes(def.id)) continue;
    const fields = def.fields.filter((one) => one.type === "date" && one.retired !== true);
    if (fields.length === 0) continue;
    const rows = yield* sql<{ id: string; key: string; fieldsJson: string }>`SELECT
        r.record_id AS id, r.key, r.fields_json AS "fieldsJson" FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = ${def.id}
        ${input.open === true ? sql`AND r.state NOT IN ('done', 'dropped')` : sql``}
        ${input.view === undefined ? sql`` : sql`AND ${viewSees(sql, input.view)}`}
        AND (${sql.or(
          fields.map(
            (one) =>
              sql`(json_extract(r.fields_json, ${`$.${one.key}`}) >= ${fromDay}
                AND json_extract(r.fields_json, ${`$.${one.key}`}) < ${toDay})`,
          ),
        )})
      ORDER BY r.key`;
    for (const row of rows) {
      const values = parseFields(row.fieldsJson);
      for (const one of fields) {
        const value = values[one.key];
        if (typeof value !== "string" || !isFieldDate(value)) continue;
        const { at, allDay } = fieldDateAt(value, zone);
        if (at >= input.from && at < input.to)
          hits.push({
            id: row.id,
            key: row.key,
            kind: "date",
            at,
            field: { key: one.key, label: one.label, allDay },
          });
      }
    }
  }
  return hits;
});

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
    /** Only what every one of these people may see (`viewSees`). */
    readonly view?: ReadonlyArray<KinPersonId> | undefined;
  },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const where = (column: "due_at" | "date_at") =>
    sql.and([
      sql`r.org_id = ${orgId}`,
      sql`${sql("r")}.${sql(column)} >= ${input.from}`,
      sql`${sql("r")}.${sql(column)} < ${input.to}`,
      ...(input.lists === undefined || input.lists.length === 0
        ? []
        : [sql`r.register_id IN ${sql.in(input.lists)}`]),
      ...(input.open === true ? [sql`r.state NOT IN ('done', 'dropped')`] : []),
      ...(input.view === undefined ? [] : [viewSees(sql, input.view)]),
    ]);
  const hits = sql`SELECT r.record_id AS id, 'due' AS kind, r.due_at AS at, r.key FROM kin_records r
      WHERE ${where("due_at")}
    UNION ALL
    SELECT r.record_id AS id, 'date' AS kind, r.date_at AS at, r.key FROM kin_records r
      WHERE ${where("date_at")}`;
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM (${hits})`;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), DATES_CAP);
  const offset = Math.max(input.offset ?? 0, 0);
  const lists = yield* allLists(orgId);
  const fielded = yield* fieldHits(orgId, lists, input);
  const page = [
    ...(yield* sql<DateHit>`SELECT id, key, kind, at FROM (${hits})
      ORDER BY at, key, kind LIMIT ${offset + limit}`),
    ...fielded,
  ]
    .toSorted(order)
    .slice(offset, offset + limit);
  const ids = [...new Set(page.map((hit) => hit.id))];
  const rows =
    ids.length === 0
      ? []
      : yield* sql<RecordRow>`${selectRecords(sql)}
          WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(ids)} ORDER BY r.record_id`;
  const byId = new Map(rows.map((row) => [row.recordId, row]));
  return {
    total: (count?.total ?? 0) + fielded.length,
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
  label:
    hit.field?.label ?? (hit.kind === "due" ? (def.dueLabel ?? "Due") : (def.dateLabel ?? "Date")),
  ...(hit.field === undefined ? {} : { field: hit.field.key }),
  at: iso(hit.at),
  allDay: hit.field?.allDay ?? (hit.kind === "due" ? row.dueAllDay : row.dateAllDay) === 1,
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
  /** Figures of only what every one of these people may see (`viewSees`), never the company's. */
  view?: ReadonlyArray<KinPersonId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const seen = view === undefined ? sql`1 = 1` : viewSees(sql, view);
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
  const owing = yield* owedInvoices({
    orgId,
    now,
    ...(view === undefined ? {} : { seen: viewSees(sql, view) }),
  });
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

  // Received: payments on invoices, and advances on their own receipts, by the day they were paid,
  // already a day in the owner's zone. Other lists paid over time are money going out.
  const paid = yield* sql<{ minor: number; currency: string; paidOn: string; withheld: number }>`
    SELECT p.amount_minor AS minor, p.currency, p.paid_on AS "paidOn", p.withheld
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND ${countedPayment(sql)}
      AND r.register_id IN ('invoices', 'receipts') AND p.paid_on >= ${since} AND ${seen}
    ORDER BY p.paid_on, p.payment_id`;
  // TDS a client deducted settles the invoice, but no money came in: it is shown on its own.
  const payments = paid.filter((one) => one.withheld === 0);
  const withheld = paid.filter((one) => one.withheld === 1);
  const receivedIn = (month: string) =>
    addUp(payments.filter((one) => monthOf(one.paidOn) === month));
  const tdsIn = (month: string) => addUp(withheld.filter((one) => monthOf(one.paidOn) === month));

  // Spent: paid expenses by their date, in the owner's zone.
  const expenses = yield* sql<{
    minor: number;
    currency: string;
    category: string | null;
    at: number;
  }>`SELECT r.amount_minor AS minor, r.currency, r.category, ${moneyDay(sql)} AS at
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND ${countedEntry(sql)} AND ${seen}
      AND r.state = 'done' AND r.amount_minor IS NOT NULL AND ${moneyDay(sql)} >= ${monthStart(monthOf(since), zone)}
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
    { from: now, to: now + 30 * DAY_MS, open: true, limit: 50, view },
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
    tdsDeducted: { thisMonth: tdsIn(thisMonth), lastMonth: tdsIn(lastMonth) },
    tdsDeductedThisFinancialYear: addUp(withheld.filter((one) => one.paidOn >= fyStart)),
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
    ...(summary.tdsDeducted === undefined ||
    summary.tdsDeducted.thisMonth.length + summary.tdsDeducted.lastMonth.length === 0
      ? {}
      : {
          tdsDeductedByClients: {
            [summary.thisMonth]: shown(summary.tdsDeducted.thisMonth),
            [summary.lastMonth]: shown(summary.tdsDeducted.lastMonth),
          },
        }),
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

/**
 * What each open client project still has to bring in beyond what was invoiced: the accepted
 * quotes, else the sent ones, else the project's value, less every invoice issued under it. The
 * answer to "how much is left from them" before the last invoice exists.
 */
export const stillToInvoice = Effect.fn("KinMoneyViews.stillToInvoice")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    key: string;
    title: string;
    client: string | null;
    value: string | null;
    list: string | null;
    state: string | null;
    minor: number | null;
    currency: string | null;
  }>`SELECT p.key, p.title, c.title AS client, json_extract(p.fields_json, '$.value') AS value,
      r.register_id AS list, r.state, r.amount_minor AS minor, r.currency
    FROM kin_records p
    LEFT JOIN kin_records c ON c.org_id = p.org_id AND c.record_id = p.party_id
    LEFT JOIN kin_records r ON r.org_id = p.org_id AND r.project_id = p.record_id
      AND r.register_id IN ('quotes', 'invoices') AND ${countedEntry(sql)}
      AND r.amount_minor IS NOT NULL
    WHERE p.org_id = ${orgId} AND p.register_id = 'projects' AND p.state = 'open'
    ORDER BY p.key, r.key LIMIT 2000`;
  const projects = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) projects.set(row.key, [...(projects.get(row.key) ?? []), row]);
  return [...projects.values()].flatMap((members) => {
    const first = members[0]!;
    const money = (list: string, states: ReadonlyArray<string>) =>
      addUp(
        members
          .filter((one) => one.list === list && states.includes(one.state ?? ""))
          .map((one) => ({ minor: one.minor!, currency: one.currency! })),
      );
    const accepted = money("quotes", ["done"]);
    const sent = money("quotes", ["waiting"]);
    const value = first.value === null ? undefined : moneyOf(first.value);
    const [agreed, basis] =
      accepted.length > 0
        ? [accepted, "accepted quotes"]
        : sent.length > 0
          ? [sent, "sent quotes"]
          : value === undefined
            ? [[], ""]
            : [[value], "the project's value"];
    const invoiced = money("invoices", ["waiting", "done"]);
    const left = agreed.flatMap((one) => {
      const billed = invoiced.find((bill) => bill.currency === one.currency)?.minor ?? 0;
      return one.minor - billed > 0 ? [{ minor: one.minor - billed, currency: one.currency }] : [];
    });
    if (left.length === 0) return [];
    return [
      {
        project: `${first.key} ${first.title}${first.client === null ? "" : ` (${first.client})`}`,
        stillToInvoice: left.map(formatMoney).join(" + "),
        agreed: `${agreed.map(formatMoney).join(" + ")}, from ${basis}`,
        invoicedSoFar: invoiced.length === 0 ? "nothing" : invoiced.map(formatMoney).join(" + "),
      },
    ];
  });
});

const moneyOf = (json: string): KinMoney | undefined => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" &&
      parsed !== null &&
      "minor" in parsed &&
      "currency" in parsed &&
      typeof parsed.minor === "number" &&
      typeof parsed.currency === "string"
      ? { minor: parsed.minor, currency: parsed.currency }
      : undefined;
  } catch {
    return undefined;
  }
};
