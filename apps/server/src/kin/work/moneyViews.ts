import * as KinShell from "../shell/KinShell.ts";
import { SECTIONS, sectionOfList, type SectionId } from "../shell/sections.ts";
import type { KinShell as Shell } from "@t3tools/contracts";
import type {
  KinDateRow,
  KinMoney,
  KinMoneyAbout,
  KinMoneySummary,
  KinOrgId,
  KinRecordRef,
} from "@t3tools/contracts";
import { kinDateRowLate, KinRecordId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { companyMoney, homeCurrency, readProfile } from "./companyProfile.ts";
import {
  aboutTotal,
  addUp,
  dayIn,
  financialYearOf,
  financialYearStart,
  formatMoney,
  formatMoneyPlain,
  monthOf,
  shiftMonth,
} from "./money.ts";
import {
  countedEntry,
  fieldDateAt,
  countedPayment,
  isSuggestion,
  issuedNumber,
  iso,
  keptEntry,
  moneyDay,
  owedInvoices,
  ownerZone,
  type RecordRow,
  selectRecords,
  toRecord,
} from "./recordRows.ts";
import { LISTS, parseFields, TEAM_LIST_RESERVED } from "./lists.ts";
import { companyCashOut, partnerRepaidDay, repaidDay } from "./reimbursement.ts";
import { findBankList } from "./statements/bankList.ts";
import {
  allLists,
  isBuiltIn,
  isFieldDate,
  type ListDef,
  listEntryFor,
  stateLabel,
} from "./registers.ts";
import { listMoneySeenBy, seenBy, type KinViewer } from "./teamView.ts";
import { DAY_MS } from "../durations.ts";
import type { SetAsideInvoice } from "../pulse/invoiceAsides.ts";

/**
 * Read views over every list: the dates view and the Money summary, computed from stored
 * integer amounts by code. Whole for the owner; for anyone else, of what `personSees` gives them.
 */

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

/** An invoice nobody has issued: no money is due on it, whatever day it carries. */
const draftInvoice = (sql: SqlClient.SqlClient) =>
  sql`(r.register_id = 'invoices' AND r.state = 'open')`;

/** The lists whose entries keep an amount, of those `asked` (all with none); never deals. */
const moneyLists = (
  lists: ReadonlyMap<string, ListDef>,
  asked: ReadonlyArray<string> | undefined,
) =>
  [...lists.values()]
    .filter(
      (def) =>
        def.amount &&
        def.id !== "deals" &&
        (asked === undefined || asked.length === 0 || asked.includes(def.id)),
    )
    .map((def) => def.id);

/** The lists' own date fields with a value in `[from, to)`, read from each entry's fields. */
const fieldHits = Effect.fn("KinMoneyViews.fieldHits")(function* (
  orgId: KinOrgId,
  lists: ReadonlyMap<string, ListDef>,
  input: {
    readonly from: number;
    readonly to: number;
    readonly lists?: ReadonlyArray<string> | undefined;
    readonly open?: boolean | undefined;
    readonly kept?: boolean | undefined;
    readonly money?: boolean | undefined;
    readonly viewer: KinViewer;
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
    const access =
      input.viewer._tag === "ownerLevel" || TEAM_LIST_RESERVED.includes(def.id)
        ? sql`1`
        : listMoneySeenBy(sql, input.viewer);
    const rows = yield* sql<{ id: string; key: string; fieldsJson: string; full: number }>`SELECT
        r.record_id AS id, r.key, r.fields_json AS "fieldsJson", ${access} AS full FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = ${def.id}
        ${input.open === true ? sql`AND r.state NOT IN ('done', 'dropped')` : sql``}
        ${input.kept === true ? sql`AND ${keptEntry(sql)}` : sql``}
        ${input.money === true ? sql`AND NOT ${draftInvoice(sql)}` : sql``}
        AND ${seenBy(sql, input.viewer)}
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
        if (one.sensitive && row.full !== 1) continue;
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
    /** Only entries someone kept, as a figure counts them. */
    readonly kept?: boolean | undefined;
    /** Only money's dates, for people's Money: lists that keep amounts, and no draft invoice. */
    readonly money?: boolean | undefined;
    readonly shell?: Shell | undefined;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
    readonly viewer: KinViewer;
  },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const lists = yield* allLists(orgId);
  const asked = input.money === true ? moneyLists(lists, input.lists) : input.lists;
  if (input.money === true && asked?.length === 0) return { total: 0, rows: [] };
  const shell = input.shell;
  const hidden =
    shell === undefined
      ? []
      : Object.keys(SECTIONS.lists).filter((id) => {
          const section = sectionOfList(id);
          return section !== null && !KinShell.sectionOn(shell, section);
        });
  const where = (column: "due_at" | "date_at") =>
    sql.and([
      sql`r.org_id = ${orgId}`,
      // A deal's expected day is the pipeline's, not a date anyone owes.
      sql`r.register_id <> 'deals'`,
      sql`${sql("r")}.${sql(column)} >= ${input.from}`,
      sql`${sql("r")}.${sql(column)} < ${input.to}`,
      ...(asked === undefined || asked.length === 0
        ? []
        : [sql`r.register_id IN ${sql.in(asked)}`]),
      ...(hidden.length === 0 ? [] : [sql`r.register_id NOT IN ${sql.in(hidden)}`]),
      ...(input.open === true ? [sql`r.state NOT IN ('done', 'dropped')`] : []),
      ...(input.kept === true ? [keptEntry(sql)] : []),
      ...(input.money === true ? [sql`NOT ${draftInvoice(sql)}`] : []),
      seenBy(sql, input.viewer),
    ]);
  const hits = sql`SELECT r.record_id AS id, 'due' AS kind, r.due_at AS at, r.key FROM kin_records r
      WHERE ${where("due_at")}
    UNION ALL
    SELECT r.record_id AS id, 'date' AS kind, r.date_at AS at, r.key FROM kin_records r
      WHERE ${where("date_at")}`;
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM (${hits})`;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), DATES_CAP);
  const offset = Math.max(input.offset ?? 0, 0);
  const fielded = yield* fieldHits(
    orgId,
    hidden.length === 0 ? lists : new Map([...lists].filter(([id]) => !hidden.includes(id))),
    { ...input, lists: asked },
  );
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
      : yield* sql<RecordRow>`${selectRecords(
          sql,
          input.viewer._tag === "ownerLevel"
            ? sql``
            : sql`, ${listMoneySeenBy(sql, input.viewer)} AS "listMoneyVisible"`,
        )}
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

/** A suggestion's or draft's day is no issue day: where its list names the day after a state, "Date". */
const dayLabel = (def: ListDef, row: RecordRow) =>
  def.dateLabel === undefined ||
  ((isSuggestion(row) || row.state === "open") &&
    def.states.some((state) => stateLabel(def, state) === def.dateLabel))
    ? "Date"
    : def.dateLabel;

const dateRow = (row: RecordRow, def: ListDef, hit: DateHit, now: number): KinDateRow => ({
  record: listEntryFor(toRecord(row, now), row.registerId, def, row.listMoneyVisible !== 0),
  listName: def.name,
  stateLabel: stateLabel(def, row.state),
  kind: hit.kind,
  label: hit.field?.label ?? (hit.kind === "due" ? (def.dueLabel ?? "Due") : dayLabel(def, row)),
  ...(hit.field === undefined ? {} : { field: hit.field.key }),
  at: iso(hit.at),
  allDay: hit.field?.allDay ?? (hit.kind === "due" ? row.dueAllDay : row.dateAllDay) === 1,
});

/**
 * Date rows as an agent reads them: an invoice's issue and due day as one entry, at its due day
 * when that is listed. Every other row is an entry of its own. Screens keep a row per day.
 */
export const datesOnce = (rows: ReadonlyArray<KinDateRow>) => {
  const invoices = new Map<string, Array<KinDateRow>>();
  const entries: Array<Array<KinDateRow>> = [];
  for (const row of rows) {
    const held = invoices.get(row.record.recordId);
    if (row.record.list !== "invoices" || row.field !== undefined) entries.push([row]);
    else if (held !== undefined) held.push(row);
    else {
      const entry = [row];
      invoices.set(row.record.recordId, entry);
      entries.push(entry);
    }
  }
  const at = (entry: ReadonlyArray<KinDateRow>) =>
    Date.parse((entry.find((row) => row.kind === "due") ?? entry[0]!).at);
  return entries.toSorted((a, b) => at(a) - at(b));
};

/** An invoice entry's days: issued (a suggestion's plain "date") and due, late only once due. */
export const invoiceDays = (
  entry: ReadonlyArray<KinDateRow>,
  day: (row: KinDateRow) => string,
): {
  readonly issued?: string;
  readonly date?: string;
  readonly due?: string;
  readonly late?: true;
} => {
  const own = entry.find((row) => row.kind === "date");
  const due = entry.find((row) => row.kind === "due");
  return {
    ...(own === undefined ? {} : own.label === "Date" ? { date: day(own) } : { issued: day(own) }),
    ...(due === undefined ? {} : { due: day(due) }),
    ...(due !== undefined && kinDateRowLate(due) ? { late: true as const } : {}),
  };
};
export const isInvoice = (entry: ReadonlyArray<KinDateRow>) =>
  entry[0]!.record.list === "invoices" && entry[0]!.field === undefined;

/**
 * The signed amount in `home` for each foreign expense a confirmed statement matched to one bank
 * line, while the line's foreign amount still equals the expense's and the expense still links it as
 * evidence: an edited expense, a removed link or an undone statement falls back to the rates. One
 * line to one expense, both ways. `seen` filters lines as `r`.
 */
const chargedAtBank = Effect.fn("KinMoneyViews.chargedAtBank")(function* (
  orgId: KinOrgId,
  expenseIds: ReadonlyArray<string>,
  home: string,
  seen: ReturnType<typeof seenBy>,
) {
  if (expenseIds.length === 0) return new Map<string, number>();
  const sql = yield* SqlClient.SqlClient;
  const bank = yield* findBankList(orgId);
  if (bank === undefined) return new Map<string, number>();
  const rows = yield* sql<{ id: string; minor: number }>`
    WITH m AS (
      SELECT e.target_record_id AS id, e.bank_record_id AS bank, e.row_index AS row,
        s.review_json AS json
      FROM kin_bank_statement_entries e
      JOIN kin_bank_statements s ON s.org_id = e.org_id AND s.statement_id = e.statement_id
      WHERE e.org_id = ${orgId} AND e.action IN ('expense_paid', 'expense_linked')
        AND s.applied_at IS NOT NULL AND s.undone_at IS NULL
        AND (e.target_record_id IN ${sql.in(expenseIds)} OR e.bank_record_id IN (
          SELECT o.bank_record_id FROM kin_bank_statement_entries o
          WHERE o.org_id = ${orgId} AND o.target_record_id IN ${sql.in(expenseIds)}))
    )
    SELECT m.id, MAX(CASE WHEN x.amount_minor < 0 THEN -ABS(r.amount_minor) ELSE ABS(r.amount_minor) END) AS minor
    FROM m
    JOIN kin_records x ON x.org_id = ${orgId} AND x.record_id = m.id
    JOIN kin_records r ON r.org_id = ${orgId} AND r.record_id = m.bank
    WHERE m.id IN ${sql.in(expenseIds)}
      AND (SELECT COUNT(DISTINCT o.bank) FROM m o WHERE o.id = m.id) = 1
      AND (SELECT COUNT(DISTINCT o.id) FROM m o WHERE o.bank = m.bank) = 1
      AND EXISTS (SELECT 1 FROM kin_record_links l WHERE l.org_id = ${orgId}
        AND l.record_id = m.id AND l.kind = 'record' AND l.relation = 'evidence'
        AND l.target = m.bank)
      AND EXISTS (SELECT 1 FROM json_each(m.json, '$.statement.rows') w
        WHERE json_extract(w.value, '$.index') = m.row
          AND json_extract(w.value, '$.direction') = CASE WHEN x.amount_minor < 0 THEN 'credit' ELSE 'debit' END
          AND json_extract(w.value, '$.foreign.currency') = x.currency
          AND json_extract(w.value, '$.foreign.amountMinor') = ABS(x.amount_minor))
      AND r.register_id = ${bank.id} AND ${countedEntry(sql)}
      AND r.currency = ${home} AND r.amount_minor IS NOT NULL AND ${seen}
    GROUP BY m.id`;
  return new Map(rows.map((one) => [one.id, one.minor]));
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

const SUGGESTED_CAP = 20;
/** Lists whose every entry is money, amount or not yet. */
const MONEY_LISTS = ["quotes", "invoices", "expenses", "receipts", "subscriptions"];

export const ownerLevelInvoicedInMonth = Effect.fn("KinMoneyViews.ownerLevelInvoicedInMonth")(
  function* (orgId: KinOrgId, month: string, zone: string) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<KinMoney>`SELECT SUM(r.amount_minor) AS minor, r.currency
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'invoices'
      AND r.state IN ('waiting', 'done') AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL
      AND ${moneyDay(sql)} >= ${monthStart(month, zone)}
      AND ${moneyDay(sql)} < ${monthStart(shiftMonth(month, 1), zone)}
    GROUP BY r.currency ORDER BY r.currency`;
  },
);

/** The Money tab's figures: owed and overdue by client, received and spent, dates ahead, a year. */
export const moneySummary = Effect.fn("KinMoneyViews.summary")(function* (
  orgId: KinOrgId,
  now: number,
  /** For people, figures of only what all of them see, never the company's. */
  viewer: KinViewer,
  /** People's Money lists money's dates alone ahead; an agent's read keeps every date. */
  options: { readonly moneyDates?: boolean; readonly shell?: Shell } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const seen = seenBy(sql, viewer);
  const zone = yield* ownerZone(orgId);
  const { homeCurrency: home, financialYearStartMonth } = yield* companyMoney(orgId);
  const rates = yield* readProfile(orgId).pipe(
    Effect.map((profile) => profile.rates),
    Effect.orElseSucceed(() => []),
  );
  const today = dayIn(now, zone);
  const thisMonth = monthOf(today);
  const lastMonth = shiftMonth(thisMonth, -1);
  const firstMonth = shiftMonth(thisMonth, -11);
  const financialYear = financialYearOf(today, financialYearStartMonth);
  const fyStart = financialYearStart(financialYear, financialYearStartMonth);
  const months = Array.from({ length: 12 }, (_, index) => shiftMonth(firstMonth, index));
  // The year's series and the financial year so far, whichever reaches further back.
  const since = `${firstMonth}-01` < fyStart ? `${firstMonth}-01` : fyStart;

  // Owed: issued invoices' balances. Payments are in the invoice's own currency.
  const shell = options.shell;
  const omitted = (id: SectionId) => shell !== undefined && !KinShell.sectionOn(shell, id);
  const invoicesOn = !omitted("invoices");
  const paidLists = invoicesOn ? ["invoices", "receipts"] : ["receipts"];
  const owing = !invoicesOn
    ? []
    : yield* owedInvoices({
        orgId,
        now,
        // A key's owner-level read is scoped too (`keyedViewer`): it leaves out what a key never carries.
        ...(viewer._tag === "ownerLevel" && viewer.keyed !== true ? {} : { seen }),
      });
  const clients = new Map<string | null, typeof owing>();
  for (const invoice of owing)
    clients.set(invoice.partyId, [...(clients.get(invoice.partyId) ?? []), invoice]);
  // An invoice they see may be a client's they don't (a sensitive client of a led project).
  const partyIds = [...clients.keys()].filter((id): id is string => id !== null);
  const named =
    viewer._tag === "ownerLevel" || partyIds.length === 0
      ? undefined
      : new Set(
          (yield* sql<{ id: string }>`SELECT r.record_id AS id FROM kin_records r
            WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(partyIds)} AND ${seen}
            ORDER BY r.record_id`).map((row) => row.id),
        );
  const byClient = [...clients].map(([partyId, members]) => {
    const first = members[0]!;
    const late = members.filter((one) => one.overdue);
    const party: KinRecordRef | null =
      partyId === null ||
      first.partyKey === null ||
      first.partyTitle === null ||
      (named !== undefined && !named.has(partyId))
        ? null
        : { recordId: KinRecordId.make(partyId), key: first.partyKey, title: first.partyTitle };
    return {
      party,
      owed: addUp(
        members.map((one) => one.balance),
        home,
      ),
      overdue: addUp(
        late.map((one) => one.balance),
        home,
      ),
      invoices: members.length,
      oldestOverdueDays: late.length === 0 ? null : Math.max(...late.map((one) => one.daysOverdue)),
    };
  });

  // Received: payments on invoices, and advances on their own receipts, by the day they were paid,
  // already a day in the owner's zone. Other lists paid over time are money going out.
  const paid = yield* sql<{ minor: number; currency: string; paidOn: string; withheld: number }>`
    SELECT p.amount_minor AS minor, p.currency, p.paid_on AS "paidOn", p.withheld
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND ${countedPayment(sql)}
      AND r.register_id IN ${sql.in(paidLists)} AND p.paid_on >= ${since} AND ${seen}
    ORDER BY p.paid_on, p.payment_id`;
  // TDS a client deducted settles the invoice, but no money came in: it is shown on its own.
  const payments = paid.filter((one) => one.withheld === 0);
  const withheld = paid.filter((one) => one.withheld === 1);
  const receivedIn = (month: string) =>
    addUp(
      payments.filter((one) => monthOf(one.paidOn) === month),
      home,
    );
  const tdsIn = (month: string) =>
    addUp(
      withheld.filter((one) => monthOf(one.paidOn) === month),
      home,
    );

  // Spent: paid expenses by their date, in the owner's zone; a partner's on the day it was paid
  // back, as runway counts it, and never while owed or given.
  const expenses = yield* sql<{
    id: string;
    minor: number;
    currency: string;
    category: string | null;
    at: number;
    repaid: string | null;
  }>`SELECT r.record_id AS id, r.amount_minor AS minor, r.currency, r.category,
      ${moneyDay(sql)} AS at, ${partnerRepaidDay(sql)} AS repaid
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND ${countedEntry(sql)} AND ${seen}
      AND r.state = 'done' AND r.amount_minor IS NOT NULL AND ${companyCashOut(sql)}
      AND (${moneyDay(sql)} >= ${monthStart(monthOf(since), zone)} OR ${repaidDay(sql)} >= ${since})
    ORDER BY at, category`;
  const charged = yield* chargedAtBank(
    orgId,
    expenses.filter((one) => one.currency !== home).map((one) => one.id),
    home,
    seen,
  );
  const spentRows = expenses.map(({ repaid, ...one }) => {
    const bank = charged.get(one.id);
    return {
      ...one,
      day: repaid ?? dayIn(one.at, zone),
      ...(bank === undefined ? {} : { charged: { minor: bank, currency: home } }),
    };
  });
  const spentIn = (month: string) => {
    const members = spentRows.filter((one) => monthOf(one.day) === month);
    const categories = new Map<string | null, Array<KinMoney>>();
    for (const one of members)
      categories.set(one.category, [...(categories.get(one.category) ?? []), one]);
    return {
      members,
      total: addUp(members, home),
      byCategory: [...categories]
        .map(([category, amounts]) => ({
          category,
          total: addUp(amounts, home),
          count: amounts.length,
        }))
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
    {
      from: now,
      to: now + 30 * DAY_MS,
      open: true,
      kept: true,
      money: options.moneyDates,
      shell,
      limit: 50,
      viewer,
    },
    now,
  );
  // Suggestions in money lists, and any other with an amount: what Money's figures leave out.
  const excluded = Object.keys(SECTIONS.lists).filter((list) => {
    const section = sectionOfList(list);
    return section !== null && omitted(section);
  });
  const suggestion = sql`r.org_id = ${orgId} AND r.confirmed = 0 AND r.state <> 'dropped'
    AND (r.register_id IN ${sql.in(MONEY_LISTS)} OR r.amount_minor IS NOT NULL) AND ${seen}
    AND ${excluded.length > 0 ? sql`r.register_id NOT IN ${sql.in(excluded)}` : sql`1 = 1`}`;
  const suggested =
    viewer._tag === "ownerLevel"
      ? yield* sql<RecordRow & { listName: string | null }>`SELECT s.*, g.name AS "listName"
          FROM (${selectRecords(sql)} WHERE ${suggestion}
            ORDER BY r.created_at DESC, r.key LIMIT ${SUGGESTED_CAP}) s
          LEFT JOIN kin_registers g ON g.org_id = ${orgId} AND g.register_id = s."registerId"
          ORDER BY s."createdAt" DESC, s.key`
      : [];
  const suggestedLists =
    viewer._tag === "ownerLevel"
      ? yield* sql<{ list: string; listName: string | null; count: number }>`
          SELECT r.register_id AS list, g.name AS "listName", COUNT(*) AS count
          FROM kin_records r
          LEFT JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id
          WHERE ${suggestion}
          GROUP BY r.register_id, g.name ORDER BY COUNT(*) DESC, r.register_id`
      : [];
  const listNamed = (list: string, name: string | null) =>
    name ?? (isBuiltIn(list) ? LISTS[list].name : list);
  const owedTotal = addUp(
    owing.map((one) => one.balance),
    home,
  );
  const overdueTotal = addUp(
    owing.filter((one) => one.overdue).map((one) => one.balance),
    home,
  );
  const received = { thisMonth: receivedIn(thisMonth), lastMonth: receivedIn(lastMonth) };
  const { members: thisMonthSpent, ...spentThisMonth } = spentIn(thisMonth);
  const { members: lastMonthSpent, ...spentLastMonth } = spentIn(lastMonth);
  const spent = { thisMonth: spentThisMonth, lastMonth: spentLastMonth };
  const about = (totals: Parameters<typeof aboutTotal>[0]) => aboutTotal(totals, home, rates);
  return {
    asOf: iso(now),
    timeZone: zone,
    thisMonth,
    lastMonth,
    financialYear,
    financialYearStartMonth,
    owed: {
      total: owedTotal,
      overdue: overdueTotal,
      invoices: owing.length,
      overdueInvoices: owing.filter((one) => one.overdue).length,
      byClient: byClient.toSorted(
        (a, b) =>
          (b.oldestOverdueDays ?? -1) - (a.oldestOverdueDays ?? -1) ||
          (b.owed[0]?.minor ?? 0) - (a.owed[0]?.minor ?? 0),
      ),
    },
    received,
    receivedThisFinancialYear: addUp(
      payments.filter((one) => one.paidOn >= fyStart),
      home,
    ),
    tdsDeducted: { thisMonth: tdsIn(thisMonth), lastMonth: tdsIn(lastMonth) },
    tdsDeductedThisFinancialYear: addUp(
      withheld.filter((one) => one.paidOn >= fyStart),
      home,
    ),
    spent,
    spentThisFinancialYear: addUp(
      spentRows.filter((one) => one.day >= fyStart),
      home,
    ),
    upcoming: upcoming.rows,
    upcomingTotal: upcoming.total,
    ...(viewer._tag === "ownerLevel"
      ? {
          suggested: suggested.map((row) => ({
            record: toRecord(row, now),
            listName: listNamed(row.registerId, row.listName),
          })),
          suggestedLists: suggestedLists.map((one) => ({
            list: one.list,
            listName: listNamed(one.list, one.listName),
            count: one.count,
          })),
        }
      : {}),
    series: months.map((month) => ({
      month,
      received: receivedIn(month),
      spent: spentIn(month).total,
    })),
    // Always present, so a live change that drops an estimate replaces the held one.
    about: {
      owed: about(owedTotal),
      overdue: about(overdueTotal),
      receivedThisMonth: about(received.thisMonth),
      receivedLastMonth: about(received.lastMonth),
      spentThisMonth: about(thisMonthSpent),
      spentLastMonth: about(lastMonthSpent),
    },
  } satisfies KinMoneySummary;
});

const shown = (totals: ReadonlyArray<KinMoney>) =>
  totals.length === 0 ? "none" : totals.map(formatMoney).join(" + ");
const SECTION_CLIENTS = 5;

/** The summary's estimates as an agent quotes them; absent when every figure is one currency. */
const aboutSection = (summary: KinMoneySummary) => {
  const about = summary.about ?? {};
  const quoted = (one: KinMoneyAbout | undefined) =>
    one === undefined
      ? undefined
      : {
          home: one.home,
          total: formatMoneyPlain(one.total),
          ...(one.missing.length === 0 ? {} : { missing: one.missing }),
        };
  const months = (thisMonth: KinMoneyAbout | undefined, lastMonth: KinMoneyAbout | undefined) =>
    thisMonth === undefined && lastMonth === undefined
      ? undefined
      : { [summary.thisMonth]: quoted(thisMonth), [summary.lastMonth]: quoted(lastMonth) };
  const section = {
    owedToUs: quoted(about.owed),
    overdue: quoted(about.overdue),
    received: months(about.receivedThisMonth, about.receivedLastMonth),
    spent: months(about.spentThisMonth, about.spentLastMonth),
  };
  return Object.values(section).every((one) => one === undefined) ? {} : { about: section };
};
const SECTION_DATES = 10;
/** A day ahead in the section: its days keyed by what its list calls each, such as `due`. */
type SectionDate = {
  readonly key: string;
  readonly number?: string;
  readonly title: string;
  readonly list: string;
  readonly [day: string]: string | true | undefined;
};
/** What the section says of its suggestions: only what the server guarantees about them. */
const SUGGESTED_NOTE =
  "Entries an agent suggested that the owner or a co-owner hasn't kept. No figure here counts them or any payment recorded on them: none is owed, due, received or spent until it is kept.";

export const moneySummaryForAgent = Effect.fn("KinMoneyViews.agentSummary")(function* (
  orgId: KinOrgId,
  now: number,
  viewer: KinViewer,
) {
  const shell = yield* KinShell.get(orgId);
  return yield* moneySummary(orgId, now, viewer, { shell });
});

/**
 * The Money summary as a short block for an owner-only prompt, built by code: figures already
 * added up, so an agent quotes them and never sums. `undefined` when there is nothing to say.
 * `setAside`: overdue invoices someone set aside until a day (`setAsideOverdue`), marked as such.
 */
export const moneySection = (
  summary: KinMoneySummary,
  zone: string,
  setAside: ReadonlyArray<SetAsideInvoice> = [],
) => {
  const nothing =
    summary.owed.invoices === 0 &&
    summary.received.thisMonth.length === 0 &&
    summary.received.lastMonth.length === 0 &&
    summary.spent.thisMonth.total.length === 0 &&
    summary.spent.lastMonth.total.length === 0 &&
    summary.upcoming.length === 0 &&
    (summary.suggested ?? []).length === 0;
  if (nothing) return undefined;
  const suggested = summary.suggested ?? [];
  const upcoming = datesOnce(summary.upcoming);
  // The total counts an invoice's two days twice wherever both are listed.
  const entries = summary.upcomingTotal - (summary.upcoming.length - upcoming.length);
  return {
    asOf: summary.asOf,
    owedToUs: shown(summary.owed.total),
    overdue: shown(summary.owed.overdue),
    ...(setAside.length === 0
      ? {}
      : { overdueSetAside: setAside.map((one) => ({ ...one, owed: shown([one.owed]) })) }),
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
    ...aboutSection(summary),
    topSpendThisMonth: summary.spent.thisMonth.byCategory.slice(0, 3).map((one) => ({
      category: one.category ?? "uncategorised",
      spent: shown(one.total),
    })),
    next30Days: upcoming.slice(0, SECTION_DATES).map((entry): SectionDate => {
      const row = entry[0]!;
      const day = (one: KinDateRow) => (one.allDay ? dayIn(Date.parse(one.at), zone) : one.at);
      const days: Readonly<Record<string, string | true>> = isInvoice(entry)
        ? invoiceDays(entry, day)
        : { [row.label.toLowerCase()]: day(row), ...(kinDateRowLate(row) ? { late: true } : {}) };
      return {
        key: row.record.key,
        ...issuedNumber(row.record.fields?.number),
        title: row.record.title,
        list: row.listName,
        ...days,
      };
    }),
    ...(entries > SECTION_DATES ? { moreDates: entries - SECTION_DATES } : {}),
    ...(suggested.length === 0
      ? {}
      : {
          suggestedNotKept: {
            note: SUGGESTED_NOTE,
            entries: suggested.map(({ record, listName }) => ({
              key: record.key,
              title: record.title,
              list: listName,
              ...(record.amount === undefined ? {} : { amount: formatMoney(record.amount) }),
              ...(record.party === undefined
                ? {}
                : { client: `${record.party.title} (${record.party.key})` }),
            })),
          },
        }),
  };
};

/**
 * What each open client project still has to bring in beyond what was invoiced: the accepted
 * quotes, else the sent ones, else the project's value, less every invoice issued under it. The
 * answer to "how much is left from them" before the last invoice exists.
 */
export const ownerLevelStillToInvoice = Effect.fn("KinMoneyViews.stillToInvoice")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const home = yield* homeCurrency(orgId);
  const rows = yield* sql<{
    key: string;
    title: string;
    client: string | null;
    value: string | null;
    kept: number;
    list: string | null;
    state: string | null;
    minor: number | null;
    currency: string | null;
  }>`SELECT p.key, p.title, c.title AS client, json_extract(p.fields_json, '$.value') AS value,
      p.confirmed AS kept, r.register_id AS list, r.state, r.amount_minor AS minor, r.currency
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
        home,
      );
    const accepted = money("quotes", ["done"]);
    const sent = money("quotes", ["waiting"]);
    // A suggested project's value is nobody's agreement yet.
    const value = first.value === null || first.kept === 0 ? undefined : moneyOf(first.value);
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
