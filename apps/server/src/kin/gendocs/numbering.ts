import {
  KinChatError,
  type KinNumberingRule,
  type KinOrgId,
  type KinRecordState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { billedParty, billingClientId } from "../work/billTo.ts";
import type { Documented } from "./amounts.ts";
import { followsCodingAgent } from "../lead/OutsideContent.ts";
import { markedKey } from "../work/keyCall.ts";
import { companyMoney } from "../work/companyProfile.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { KIN_OWN_REFUSAL, refuseKinOwn } from "../people/KinAccess.ts";
import { isMoney, parseFields } from "../work/lists.ts";
import { dayIn, financialYearOf, formatMoney } from "../work/money.ts";
import {
  stillSuggestion,
  endOfDay,
  notFound,
  ownerZone,
  receiptNumbersIn,
  type RecordRow,
  termsDays,
  workFailure,
} from "../work/recordRows.ts";
import { playbookThreshold } from "../work/playbooks.ts";
import { type ListDef, listDef, numberingOf, unknownList } from "../work/registers.ts";

/**
 * Numbers a list issues (CGST Rule 46(b)): consecutive within a series, at most 16 characters of
 * letters, digits, hyphen and slash, unique for a financial year. Issued by the server in one
 * transaction when an entry is issued, bound to it for good, and never reused: a voided entry
 * keeps its number, so the series has no gaps.
 */

export const MAX_NUMBER_LENGTH = 16;
/** A number Kin keeps but never continues: one in no series of the list's rule. */
export const IMPORTED_SERIES = "imported";

/**
 * Where an issued number sits: `OBK/2026-27/013` and `OBK/26-27/013` in the list's series for
 * 26-27, `INV/2026/004` in the one for 2026 when the company's year starts in January
 * (`startMonth` 1), `OBK/13` in a running one, anything else in a series Kin never continues.
 */
export const seriesOf = (rule: KinNumberingRule, number: string, startMonth: number) => {
  const prefix = rule.prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  if (rule.series === "running") {
    const found = new RegExp(`^${prefix}[/-](\\d{1,9})$`).exec(number);
    if (found !== null)
      return { series: `${rule.prefix}|running`, seq: Number.parseInt(found[1]!, 10) };
  } else {
    const calendar =
      startMonth === 1 ? new RegExp(`^${prefix}[/-](\\d{4})[/-](\\d{1,9})$`).exec(number) : null;
    if (calendar !== null)
      return { series: `${rule.prefix}|${calendar[1]}`, seq: Number.parseInt(calendar[2]!, 10) };
    const found = new RegExp(`^${prefix}[/-](?:\\d{2})?(\\d{2})-(\\d{2})[/-](\\d{1,9})$`).exec(
      number,
    );
    if (found !== null && (Number(found[1]) + 1) % 100 === Number(found[2]))
      return {
        series: `${rule.prefix}|${found[1]}-${found[2]}`,
        seq: Number.parseInt(found[3]!, 10),
      };
  }
  return { series: `${IMPORTED_SERIES}|${number}`, seq: 1 };
};
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isChatError = Schema.is(KinChatError);
/** As every issue answers, so a caller reads `notice` whichever way it went. */
const answered = (issued: Issued): Issued => issued;

/** `26-27` for any day from 1 April 2026 to 31 March 2027 in a year from April; `2026` from January. */
const financialYear = (day: string, startMonth: number) => {
  const year = financialYearOf(day, startMonth);
  return startMonth === 1 ? year.slice(2) : year.slice(4);
};

const formatNumber = (rule: KinNumberingRule, year: string | null, seq: number) =>
  [
    rule.prefix,
    rule.series === "financial_year" ? year : null,
    String(seq).padStart(rule.width, "0"),
  ]
    .filter((part) => part !== null)
    .join("/");

/** Why a rule can't make numbers within the limit at its own width, or `undefined`. */
export const ruleProblem = (rule: KinNumberingRule) =>
  formatNumber(rule, "26-27", 10 ** rule.width - 1).length > MAX_NUMBER_LENGTH
    ? `${formatNumber(rule, "26-27", 1)} is too long: a number holds at most ${MAX_NUMBER_LENGTH} characters, so shorten the prefix or the width.`
    : undefined;

export type Issued = {
  readonly key: string;
  readonly number: string | null;
  readonly state: KinRecordState;
  readonly issued: boolean;
  /** Said plainly when its number follows entries dated after it. */
  readonly notice?: string;
};

/** The number an entry was issued, if it has one. */
export const issuedNumber = Effect.fn("KinNumbers.issued")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ number: string }>`SELECT number FROM kin_issued_numbers
    WHERE org_id = ${orgId} AND record_id = ${recordId} ORDER BY record_id`;
  return row?.number;
});

/** The series a number issued now goes in, and how far past it the old system's receipts reach. */
const seriesToday = Effect.fn("KinNumbers.seriesToday")(function* (
  orgId: KinOrgId,
  registerId: string,
  rule: KinNumberingRule,
) {
  const now = yield* Clock.currentTimeMillis;
  const zone = yield* ownerZone(orgId);
  const day = dayIn(now, zone);
  const { financialYearStartMonth: startMonth } = yield* companyMoney(orgId);
  const year = rule.series === "financial_year" ? financialYear(day, startMonth) : null;
  const series = `${rule.prefix}|${year ?? "running"}`;
  // A receipt number the old system issued may still sit only in a payment's note: past it.
  const floor =
    registerId === "receipts" ? yield* notedFloor(orgId, rule, year, series, startMonth) : 0;
  return { now, zone, day, year, series, floor };
});

const shiftDay = (day: string, days: number) =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));

/**
 * Days an invoice issued with no due date is given to be paid: its client's terms when they
 * name days ("Net 30"), else the playbook's `payment_due_days`.
 */
const paymentDays = Effect.fn("KinNumbers.paymentDays")(function* (
  orgId: KinOrgId,
  row: RecordRow,
) {
  const sql = yield* SqlClient.SqlClient;
  const partyId = billingClientId(row);
  const inheritsProject = partyId === null && billedParty(row, undefined) === undefined;
  const [client] = yield* sql<{ id: string; terms: string | null }>`SELECT c.record_id AS id,
      json_extract(c.fields_json, '$.terms') AS terms
    FROM kin_records c
    WHERE c.org_id = ${orgId} AND c.register_id = 'clients' AND c.record_id = COALESCE(
      ${partyId}, (SELECT p.party_id FROM kin_records p
        WHERE p.org_id = ${orgId} AND p.record_id = ${inheritsProject ? row.projectId : null}))`;
  return (
    termsDays(client?.terms) ??
    (yield* playbookThreshold(orgId, "payment_due_days", client?.id)).value
  );
});

/** Issuing makes an entry owed (an invoice is Issued); a quote stays a draft until it is sent. */
const issuedOwes = (def: ListDef) => def.states.includes("waiting") && def.id !== "quotes";

/**
 * The number issuing the entry `key` would give it now, read without taking it: `null` when it
 * has one, is void, or its list doesn't number its entries.
 */
export const nextNumber = Effect.fn("KinNumbers.next")(function* (orgId: KinOrgId, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* (yield* KinRecords).get(orgId, key);
  if (row === undefined) return yield* notFound(key);
  const def = yield* listDef(orgId, row.registerId);
  const rule = def === undefined ? undefined : numberingOf(def);
  if (def === undefined || rule === undefined || row.state === "dropped") return null;
  if ((yield* issuedNumber(orgId, row.recordId)) !== undefined) return null;
  const { year, series, floor } = yield* seriesToday(orgId, def.id, rule);
  const [last] = yield* sql<{ seq: number }>`SELECT last_seq AS seq FROM kin_number_series
      WHERE org_id = ${orgId} AND register_id = ${def.id} AND series = ${series}`;
  const number = formatNumber(rule, year, Math.max(last?.seq ?? 0, floor) + 1);
  return number.length > MAX_NUMBER_LENGTH ? null : number;
}, workFailure);

/**
 * Issues the entry `key`: the next number in its list's series for today in the owner's zone,
 * written to its `number` field, its state moved from draft to issued and its date set if it
 * had none. Asking again returns the number it has and changes nothing.
 */
export const issue = Effect.fn("KinNumbers.issue")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
  /** What the entry's documents come to (`amounts.ts`): the amount and tax it is issued with. */
  documented?: Documented,
) {
  yield* byAPerson(orgId, writer);
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  yield* refuseKinOwn(orgId, writer, KIN_OWN_REFUSAL.number);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* records.get(orgId, key);
      if (row === undefined) return yield* notFound(key);
      const def = yield* listDef(orgId, row.registerId);
      if (def === undefined) return yield* unknownList(row.registerId);
      const rule = numberingOf(def);
      if (rule === undefined) return yield* invalid(`${def.name} doesn't number its entries.`);
      const had = yield* issuedNumber(orgId, row.recordId);
      if (had !== undefined)
        return answered({ key: row.key, number: had, state: row.state, issued: false });
      if (row.state === "dropped")
        return yield* invalid(`${row.key} is void, so it gets no number. Make a new one instead.`);
      // A suggestion takes no number in the company's series until a person keeps it.
      if (row.confirmed === 0) return yield* invalid(stillSuggestion(row.key));
      // An issued entry always carries its amount, whatever its list says about amounts.
      if (!def.amount)
        return yield* invalid(
          `${def.name} keeps no amounts, and an issued entry always carries its amount, so ${row.key} wasn't issued. Nothing was issued.`,
        );
      const priced = pricedBy(row, def, documented);
      if (isChatError(priced)) return yield* priced;
      const { now, zone, day, year, series, floor } = yield* seriesToday(orgId, def.id, rule);
      if (floor > 0)
        yield* sql`INSERT INTO kin_number_series (org_id, register_id, series, last_seq)
          VALUES (${orgId}, ${def.id}, ${series}, ${floor})
          ON CONFLICT (org_id, register_id, series) DO UPDATE
            SET last_seq = MAX(kin_number_series.last_seq, excluded.last_seq)`;
      const [next] = yield* sql<{ seq: number }>`INSERT INTO kin_number_series
            (org_id, register_id, series, last_seq)
          VALUES (${orgId}, ${def.id}, ${series}, 1)
          ON CONFLICT (org_id, register_id, series) DO UPDATE SET last_seq = last_seq + 1
          RETURNING last_seq AS seq`;
      if (next === undefined) return yield* invalid("Kin couldn't issue a number.");
      const number = formatNumber(rule, year, next.seq);
      if (number.length > MAX_NUMBER_LENGTH)
        return yield* invalid(
          `${def.name}'s next number, ${number}, is over ${MAX_NUMBER_LENGTH} characters; the owner can widen or shorten its numbering.`,
        );
      const by =
        writer.actor._tag === "person"
          ? { kind: "person", id: writer.actor.personId }
          : writer.actor._tag === "agent"
            ? { kind: "agent", id: writer.actor.agentId }
            : undefined;
      if (by === undefined) return yield* invalid("Only the owner or an agent issues a number.");
      yield* sql`INSERT INTO kin_issued_numbers (org_id, register_id, series, seq, number,
            record_id, issued_at, issued_by_kind, issued_by_id)
          VALUES (${orgId}, ${def.id}, ${series}, ${next.seq}, ${number}, ${row.recordId}, ${now},
            ${by.kind}, ${by.id})`;
      if (def.fields.some((field) => field.key === "number"))
        yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', ${number})
            WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
      const dated = row.dateAt === null && def.builtIn === null ? endOfDay(day, zone) : row.dateAt;
      // Allowed, as the owner may need it, but never silent: its number follows later-dated ones.
      const [later] =
        dated === null
          ? []
          : yield* sql<{ number: string; dateAt: number }>`SELECT n.number, r.date_at AS "dateAt"
              FROM kin_issued_numbers n
              JOIN kin_records r ON r.org_id = n.org_id AND r.record_id = n.record_id
              WHERE n.org_id = ${orgId} AND n.register_id = ${def.id} AND n.series = ${series}
                AND n.record_id <> ${row.recordId} AND r.date_at > ${dated}
              ORDER BY r.date_at DESC, n.seq DESC LIMIT 1`;
      // Kin's own words from its own values (a number is letters, digits, / and -), never a list's.
      const notice =
        later === undefined || dated === null || dayIn(later.dateAt, zone) <= dayIn(dated, zone)
          ? undefined
          : `${number} is dated ${shownDay(dayIn(dated, zone))}, before ${later.number} (${shownDay(dayIn(later.dateAt, zone))}), which was issued first: its number comes after entries dated later.`;
      const dueDays =
        def.id === "invoices" && row.dueAt === null ? yield* paymentDays(orgId, row) : undefined;
      const issuedDay = dated === null ? day : dayIn(dated, zone);
      const updated = yield* records.update(
        orgId,
        writer,
        row.key,
        {
          ...(dueDays === undefined
            ? {}
            : { dueAt: endOfDay(shiftDay(issuedDay, dueDays), zone), dueAllDay: true }),
          ...(row.state === "open" && issuedOwes(def) ? { state: "waiting" as const } : {}),
          ...(row.dateAt === null && def.builtIn === null
            ? { dateAt: endOfDay(day, zone), dateAllDay: true }
            : {}),
          ...priced,
        },
        undefined,
        [{ field: "number", from: null, to: number }],
      );
      if (notice !== undefined)
        yield* records.update(orgId, { actor: { _tag: "system" }, via: writer.via }, row.key, {
          notes: updated.notes === "" ? notice : `${updated.notes}\n\n${notice}`,
        });
      return answered({
        key: updated.key,
        number,
        state: updated.state,
        issued: true,
        ...(notice === undefined ? {} : { notice }),
      });
    }),
  );
}, workFailure);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shownDay = (day: string) =>
  `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

/**
 * What issuing writes to an entry: the total and tax its documents come to, which must be what it
 * already records when it records them; else its own amount. One with neither is refused.
 */
const pricedBy = (row: RecordRow, def: ListDef, documented: Documented | undefined) => {
  if (documented?._tag === "refused")
    return invalid(`${row.key} wasn't issued: ${documented.reason} Nothing was issued.`);
  if (documented === undefined) {
    if (row.amountMinor !== null) return {};
    return invalid(
      `${row.key} has no amount. Make its document from its lines, or give it its amount, then issue it. Nothing was issued.`,
    );
  }
  const { total, tax } = documented.figures;
  const recorded =
    row.amountMinor === null ? undefined : { minor: row.amountMinor, currency: row.currency ?? "" };
  if (
    recorded !== undefined &&
    (recorded.minor !== total.minor || recorded.currency !== total.currency)
  )
    return invalid(
      `${row.key} is recorded at ${formatMoney(recorded)}, but its document comes to ${formatMoney(total)}. Correct whichever is wrong, the entry's amount or the document's lines or recipe, then issue it. Nothing was issued.`,
    );
  const taxField = def.fields.some((field) => field.key === "tax" && field.type === "money");
  const stored = parseFields(row.fieldsJson).tax;
  const storedTax = stored !== undefined && stored !== null && isMoney(stored) ? stored : undefined;
  if (
    taxField &&
    storedTax !== undefined &&
    (storedTax.minor !== tax.minor || storedTax.currency !== tax.currency)
  )
    return invalid(
      `${row.key} records ${formatMoney(storedTax)} of tax, but its document charges ${formatMoney(tax)}. Correct whichever is wrong, then issue it. Nothing was issued.`,
    );
  return {
    ...(recorded === undefined ? { amount: total } : {}),
    ...(taxField && storedTax === undefined ? { fields: { tax } } : {}),
  };
};

/**
 * The highest number in `series` an imported payment, not taken back, holds in its note as the
 * receipt the old system gave it. Only an import writes such a number, and one Kin could never
 * issue after (over the length limit) is no number at all.
 */
const notedFloor = Effect.fn("KinNumbers.notedFloor")(function* (
  orgId: KinOrgId,
  rule: KinNumberingRule,
  year: string | null,
  series: string,
  startMonth: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const notes = yield* sql<{ note: string }>`SELECT note FROM kin_record_payments
    WHERE org_id = ${orgId} AND origin_key LIKE 'import:%' AND voided_at IS NULL
      AND instr(note, ${rule.prefix}) > 0
    ORDER BY payment_id LIMIT 10000`;
  let highest = 0;
  for (const { note } of notes)
    for (const number of receiptNumbersIn(note)) {
      const at = seriesOf(rule, number, startMonth);
      if (at.series === series && formatNumber(rule, year, at.seq).length <= MAX_NUMBER_LENGTH)
        highest = Math.max(highest, at.seq);
    }
  return highest;
});

/**
 * Gives the entry `key` a number another system already issued, instead of a new one: kept for
 * good like an issued one, and its series moves past it so Kin never issues it again. Asking
 * again with the same number changes nothing.
 */
export const adopt = Effect.fn("KinNumbers.adopt")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
  number: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  yield* refuseKinOwn(orgId, writer, KIN_OWN_REFUSAL.number);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* records.get(orgId, key);
      if (row === undefined) return yield* notFound(key);
      const def = yield* listDef(orgId, row.registerId);
      if (def === undefined) return yield* unknownList(row.registerId);
      const rule = numberingOf(def);
      if (rule === undefined) return yield* invalid(`${def.name} doesn't number its entries.`);
      const had = yield* issuedNumber(orgId, row.recordId);
      if (had !== undefined) {
        if (had === number)
          return { key: row.key, number, state: row.state, issued: false } satisfies Issued;
        return yield* invalid(`${row.key} already has the number ${had}.`);
      }
      if (!/^[A-Za-z0-9/-]{1,32}$/.test(number))
        return yield* invalid(`${number.slice(0, 40)} isn't a number Kin can keep.`);
      const { series, seq } = seriesOf(
        rule,
        number,
        (yield* companyMoney(orgId)).financialYearStartMonth,
      );
      if (
        !series.startsWith(`${IMPORTED_SERIES}|`) &&
        formatNumber(rule, series.split("|")[1] ?? null, seq + 1).length > MAX_NUMBER_LENGTH
      )
        return yield* invalid(
          `${number} would leave no number of at most ${MAX_NUMBER_LENGTH} characters after it in its series.`,
        );
      const clash = yield* sql`SELECT 1 FROM kin_issued_numbers WHERE org_id = ${orgId}
        AND register_id = ${def.id}
        AND (number = ${number} OR (series = ${series} AND seq = ${seq})) LIMIT 1`;
      if (clash.length > 0) return yield* invalid(`${number} is already issued in Kin.`);
      const by =
        writer.actor._tag === "person"
          ? { kind: "person", id: writer.actor.personId }
          : writer.actor._tag === "agent"
            ? { kind: "agent", id: writer.actor.agentId }
            : undefined;
      if (by === undefined) return yield* invalid("Only the owner or an agent issues a number.");
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO kin_issued_numbers (org_id, register_id, series, seq, number,
          record_id, issued_at, issued_by_kind, issued_by_id)
        VALUES (${orgId}, ${def.id}, ${series}, ${seq}, ${number}, ${row.recordId}, ${now},
          ${by.kind}, ${by.id})`;
      if (!series.startsWith(`${IMPORTED_SERIES}|`))
        yield* sql`INSERT INTO kin_number_series (org_id, register_id, series, last_seq)
          VALUES (${orgId}, ${def.id}, ${series}, ${seq})
          ON CONFLICT (org_id, register_id, series) DO UPDATE
            SET last_seq = MAX(kin_number_series.last_seq, excluded.last_seq)`;
      if (def.fields.some((field) => field.key === "number"))
        yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', ${number})
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
      const updated = yield* records.update(
        orgId,
        writer,
        row.key,
        row.state === "open" && issuedOwes(def) ? { state: "waiting" as const } : {},
        undefined,
        [{ field: "number", from: null, to: number }],
      );
      return { key: updated.key, number, state: updated.state, issued: true } satisfies Issued;
    }),
  );
}, workFailure);

/**
 * Takes a void entry back: paid when its payments cover it, else owed again once it has its number,
 * else a draft. Its number, series and payments are as they were. A void receipt stays void: the
 * payment it was for may have a new one already.
 */
export const unvoidEntry = Effect.fn("KinNumbers.unvoid")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  yield* refuseKinOwn(orgId, writer, KIN_OWN_REFUSAL.number);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* records.get(orgId, key);
      if (row === undefined) return yield* notFound(key);
      const def = yield* listDef(orgId, row.registerId);
      if (def === undefined) return yield* unknownList(row.registerId);
      if (def.id === "receipts")
        return yield* invalid(`${row.key} is a void receipt, and stays void. Make a new one.`);
      const number = (yield* issuedNumber(orgId, row.recordId)) ?? null;
      if (row.state !== "dropped")
        return { key: row.key, number, state: row.state, issued: false } satisfies Issued;
      const paidUp = row.amountMinor !== null && row.amountMinor - row.paid <= 0;
      const state =
        paidUp && def.states.includes("done")
          ? ("done" as const)
          : number !== null && issuedOwes(def)
            ? ("waiting" as const)
            : ("open" as const);
      const updated = yield* records.update(orgId, writer, row.key, { state });
      return { key: updated.key, number, state: updated.state, issued: false } satisfies Issued;
    }),
  );
}, workFailure);

const BY_THE_PERSON = new KinChatError({
  reason: "not_allowed",
  message:
    "Words from a person's coding agent can't issue or void an entry: the person issues or voids it in Kin.",
});
/**
 * Issuing and voiding need a person: never a write through a coding agent's key, nor a turn that
 * follows words it sent or wrote, directly or passed on.
 */
const byAPerson = Effect.fn("KinNumbers.byAPerson")(function* (orgId: KinOrgId, writer: Writer) {
  if ((yield* markedKey(writer)) !== undefined) return yield* BY_THE_PERSON;
  if (
    writer.actor._tag === "agent" &&
    writer.wakeupId !== undefined &&
    (yield* followsCodingAgent({ orgId, wakeupId: writer.wakeupId }))
  )
    return yield* BY_THE_PERSON;
});

/** Voids the entry: kept, with its number if it was issued. Voiding a void entry changes nothing. */
export const voidEntry = Effect.fn("KinNumbers.void")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  yield* byAPerson(orgId, writer);
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  yield* refuseKinOwn(orgId, writer, KIN_OWN_REFUSAL.number);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* records.get(orgId, key);
      if (row === undefined) return yield* notFound(key);
      const def = yield* listDef(orgId, row.registerId);
      if (def === undefined) return yield* unknownList(row.registerId);
      if (numberingOf(def) === undefined || !def.states.includes("dropped"))
        return yield* invalid(`${def.name} entries aren't voided; close them instead.`);
      const number = (yield* issuedNumber(orgId, row.recordId)) ?? null;
      if (row.state === "dropped")
        return { key: row.key, number, state: row.state, issued: false } satisfies Issued;
      const updated = yield* records.update(orgId, writer, row.key, { state: "dropped" });
      return { key: updated.key, number, state: updated.state, issued: false } satisfies Issued;
    }),
  );
}, workFailure);
