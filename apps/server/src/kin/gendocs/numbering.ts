import { KinChatError, type KinNumberingRule, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { dayIn, financialYearOf } from "../work/money.ts";
import { endOfDay, notFound, ownerZone, workFailure } from "../work/recordRows.ts";
import { listDef, numberingOf, unknownList } from "../work/registers.ts";

/**
 * Numbers a list issues (CGST Rule 46(b)): consecutive within a series, at most 16 characters of
 * letters, digits, hyphen and slash, unique for a financial year. Issued by the server in one
 * transaction when an entry is issued, bound to it for good, and never reused: a voided entry
 * keeps its number, so the series has no gaps.
 */

const MAX_NUMBER_LENGTH = 16;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** `26-27` for any day from 1 April 2026 to 31 March 2027. */
const financialYear = (day: string) => financialYearOf(day).slice(4);

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
  readonly state: string;
  readonly issued: boolean;
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

/**
 * Issues the entry `key`: the next number in its list's series for today in the owner's zone,
 * written to its `number` field, its state moved from draft to issued and its date set if it
 * had none. Asking again returns the number it has and changes nothing.
 */
export const issue = Effect.fn("KinNumbers.issue")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
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
        return { key: row.key, number: had, state: row.state, issued: false } satisfies Issued;
      if (row.state === "dropped")
        return yield* invalid(`${row.key} is void, so it gets no number. Make a new one instead.`);
      const now = yield* Clock.currentTimeMillis;
      const zone = yield* ownerZone(orgId);
      const day = dayIn(now, zone);
      const year = rule.series === "financial_year" ? financialYear(day) : null;
      const series = `${rule.prefix}|${year ?? "running"}`;
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
      const updated = yield* records.update(
        orgId,
        writer,
        row.key,
        {
          ...(row.state === "open" && def.states.includes("waiting")
            ? { state: "waiting" as const }
            : {}),
          ...(row.dateAt === null && def.builtIn === null
            ? { dateAt: endOfDay(day, zone), dateAllDay: true }
            : {}),
        },
        undefined,
        [{ field: "number", from: null, to: number }],
      );
      return { key: updated.key, number, state: updated.state, issued: true } satisfies Issued;
    }),
  );
}, workFailure);

/** Voids the entry: kept, with its number if it was issued. Voiding a void entry changes nothing. */
export const voidEntry = Effect.fn("KinNumbers.void")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
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
