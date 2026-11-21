import type { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { dayIn } from "./money.ts";
import { endOfDay, parseChanges } from "./recordRows.ts";

const PAGE = 1_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
type Was = { readonly due: number | null; readonly date: number | null };
type Json = Readonly<Record<string, unknown>>;
const objectOf = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const parsed = (json: string | null) =>
  json === null ? undefined : objectOf(Option.getOrUndefined(fromJson(json)));

/**
 * In the caller's transaction, as the company's zone moves `from` → `to`: every all-day instant
 * the org keeps (a day's last millisecond in `from`, `endOfDay`) becomes that day's in `to`, so no
 * day reads one off. Entries' columns, their history and undo, a statement's undo, and the pulse
 * ledgers keyed by a due move with it; timed values stay. Returns how many entries moved.
 */
export const keepAllDayDays = Effect.fn("KinWork.keepAllDayDays")(function* (
  orgId: KinOrgId,
  from: string,
  to: string,
) {
  if (from === to) return 0;
  const sql = yield* SqlClient.SqlClient;
  const anchored = new Map<number, number>();
  const anchor = (at: number) => {
    let next = anchored.get(at);
    if (next === undefined) anchored.set(at, (next = endOfDay(dayIn(at, from), to)));
    return next;
  };
  // History keeps no all-day flag: a value is a day when it is the entry's all-day value now, or a
  // day's end in `from`. A timed value set to exactly 23:59:59.999 there would move too.
  const was = new Map<string, Was>();
  const ends = new Map<number, boolean>();
  const isDay = (recordId: string | null, field: keyof Was, at: number) => {
    if (recordId !== null && was.get(recordId)?.[field] === at) return true;
    let end = ends.get(at);
    if (end === undefined) ends.set(at, (end = endOfDay(dayIn(at, from), from) === at));
    return end;
  };
  const keyed = new Map<string, string>();
  let entries = 0;
  // Materialized, each pair finds its row by key; joined as is, SQLite scans the org per pair.
  const pairs = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
    sql`WITH m(a, b, c, d) AS MATERIALIZED (SELECT json_extract(value, '$[0]'),
      json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
      FROM json_each(${toJson(rows)}))`;

  let record = "";
  for (;;) {
    const rows = yield* sql<{
      id: string;
      key: string;
      dueAt: number | null;
      dueAllDay: number;
      dateAt: number | null;
      dateAllDay: number;
    }>`SELECT record_id AS id, key, due_at AS "dueAt", due_all_day AS "dueAllDay",
        date_at AS "dateAt", date_all_day AS "dateAllDay"
      FROM kin_records WHERE org_id = ${orgId} AND record_id > ${record}
        AND ((due_all_day = 1 AND due_at IS NOT NULL) OR (date_all_day = 1 AND date_at IS NOT NULL))
      ORDER BY record_id LIMIT ${PAGE}`;
    if (rows.length === 0) break;
    record = rows.at(-1)!.id;
    const moved: Array<readonly [string, number | null, number | null]> = [];
    for (const row of rows) {
      const due = row.dueAllDay === 1 ? row.dueAt : null;
      const date = row.dateAllDay === 1 ? row.dateAt : null;
      was.set(row.id, { due, date });
      const nextDue = due === null ? row.dueAt : anchor(due);
      const nextDate = date === null ? row.dateAt : anchor(date);
      if (due !== null && nextDue !== due)
        keyed.set(`${row.key}:due=${due}`, `${row.key}:due=${nextDue}`);
      if (nextDue !== row.dueAt || nextDate !== row.dateAt) moved.push([row.id, nextDue, nextDate]);
    }
    entries += moved.length;
    if (moved.length > 0)
      yield* sql`${pairs(moved)} UPDATE kin_records SET due_at = m.b, date_at = m.c FROM m
        WHERE kin_records.org_id = ${orgId} AND kin_records.record_id = m.a`;
  }

  // History lines, and so the Undo that puts a line's `from` back.
  let seq = 0;
  for (;;) {
    const rows = yield* sql<{ seq: number; recordId: string; fieldsJson: string }>`SELECT seq,
        record_id AS "recordId", fields_json AS "fieldsJson"
      FROM kin_record_changes WHERE org_id = ${orgId} AND seq > ${seq}
        AND instr(fields_json, '.999Z') > 0
      ORDER BY seq LIMIT ${PAGE}`;
    if (rows.length === 0) break;
    seq = rows.at(-1)!.seq;
    const moved: Array<readonly [number, string]> = [];
    for (const row of rows) {
      let changed = false;
      const shift = (field: keyof Was, value: string | null) => {
        const at = value === null ? Number.NaN : Date.parse(value);
        if (!Number.isFinite(at) || !isDay(row.recordId, field, at)) return value;
        const next = iso(anchor(at));
        changed ||= next !== value;
        return next;
      };
      const fields = parseChanges(row.fieldsJson).map((one) =>
        one.field === "due" || one.field === "date"
          ? { ...one, from: shift(one.field, one.from), to: shift(one.field, one.to) }
          : one,
      );
      if (changed) moved.push([row.seq, toJson(fields)]);
    }
    if (moved.length > 0)
      yield* sql`${pairs(moved)} UPDATE kin_record_changes SET fields_json = m.b FROM m
        WHERE kin_record_changes.org_id = ${orgId} AND kin_record_changes.seq = m.a`;
  }

  // A statement's undo puts an expense's date back, and leaves an entry a person changed since.
  let place: readonly [string, number] = ["", -1];
  for (;;) {
    const rows = yield* sql<{
      statementId: string;
      seq: number;
      bank: string;
      target: string | null;
      prior: string | null;
      after: string | null;
    }>`SELECT statement_id AS "statementId", seq, bank_record_id AS bank,
        target_record_id AS target, prior_json AS prior, after_json AS after
      FROM kin_bank_statement_entries WHERE org_id = ${orgId}
        AND (statement_id, seq) > (${place[0]}, ${place[1]})
        AND (instr(prior_json, '"dateAt":') > 0 OR instr(after_json, '"dateAt":') > 0)
      ORDER BY statement_id, seq LIMIT ${PAGE}`;
    if (rows.length === 0) break;
    const last = rows.at(-1)!;
    place = [last.statementId, last.seq];
    const moved: Array<readonly [string, number, string | null, string | null]> = [];
    for (const row of rows) {
      let changed = false;
      const shift = (holder: unknown, recordId: string | null, flagged: boolean) => {
        const held = objectOf(holder);
        const at = held?.["dateAt"];
        if (
          held === undefined ||
          typeof at !== "number" ||
          !(flagged ? held["dateAllDay"] === true : isDay(recordId, "date", at))
        )
          return holder;
        const next = anchor(at);
        changed ||= next !== at;
        return { ...held, dateAt: next };
      };
      const prior = parsed(row.prior);
      const kept = parsed(row.after);
      const nextPrior =
        prior?.["expense"] === undefined
          ? prior
          : { ...prior, expense: shift(prior["expense"], row.target, true) };
      const nextKept =
        kept === undefined
          ? kept
          : {
              ...kept,
              ...(kept["bank"] === undefined ? {} : { bank: shift(kept["bank"], row.bank, false) }),
              ...(kept["target"] === undefined
                ? {}
                : { target: shift(kept["target"], row.target, false) }),
            };
      if (changed)
        moved.push([
          row.statementId,
          row.seq,
          nextPrior === undefined ? row.prior : toJson(nextPrior),
          nextKept === undefined ? row.after : toJson(nextKept),
        ]);
    }
    if (moved.length > 0)
      yield* sql`${pairs(moved)} UPDATE kin_bank_statement_entries
        SET prior_json = m.c, after_json = m.d FROM m
        WHERE kin_bank_statement_entries.org_id = ${orgId}
          AND kin_bank_statement_entries.statement_id = m.a AND kin_bank_statement_entries.seq = m.b`;
  }

  // A fact about a due carries it in its key (`task_late:W-2:due=…`): the same news keeps its key.
  // Each ledger row is renamed by its rowid, so none is scanned for per pair.
  if (keyed.size === 0) return entries;
  const renamed = (rows: ReadonlyArray<{ id: number; key: string }>) =>
    rows.flatMap((row) => {
      const sense = row.key.indexOf(":");
      const next = sense < 0 ? undefined : keyed.get(row.key.slice(sense + 1));
      return next === undefined ? [] : [[row.id, `${row.key.slice(0, sense)}:${next}`] as const];
    });
  const facts = renamed(
    yield* sql<{ id: number; key: string }>`SELECT rowid AS id, fact_key AS key
      FROM kin_pulse_facts WHERE org_id = ${orgId} AND instr(fact_key, ':due=') > 0 ORDER BY rowid`,
  );
  for (let start = 0; start < facts.length; start += PAGE)
    yield* sql`${pairs(facts.slice(start, start + PAGE))} UPDATE kin_pulse_facts SET fact_key = m.b
      FROM m WHERE kin_pulse_facts.rowid = m.a AND kin_pulse_facts.org_id = ${orgId}
        AND NOT EXISTS (SELECT 1 FROM kin_pulse_facts x WHERE x.org_id = ${orgId}
          AND x.fact_key = m.b)`;
  const told = renamed(
    yield* sql<{ id: number; key: string }>`SELECT rowid AS id, fact_key AS key
      FROM kin_pulse_told WHERE org_id = ${orgId} AND instr(fact_key, ':due=') > 0 ORDER BY rowid`,
  );
  for (let start = 0; start < told.length; start += PAGE)
    yield* sql`${pairs(told.slice(start, start + PAGE))} UPDATE kin_pulse_told SET fact_key = m.b
      FROM m WHERE kin_pulse_told.rowid = m.a AND kin_pulse_told.org_id = ${orgId}
        AND NOT EXISTS (SELECT 1 FROM kin_pulse_told x WHERE x.org_id = ${orgId}
          AND x.person_id = kin_pulse_told.person_id AND x.fact_key = m.b
          AND x.event_id = kin_pulse_told.event_id)`;
  const nudged = renamed(
    yield* sql<{ id: number; key: string }>`SELECT rowid AS id, fact_key AS key
      FROM kin_pulse_nudges WHERE org_id = ${orgId} AND instr(fact_key, ':due=') > 0 ORDER BY rowid`,
  );
  for (let start = 0; start < nudged.length; start += PAGE)
    yield* sql`${pairs(nudged.slice(start, start + PAGE))} UPDATE kin_pulse_nudges
      SET fact_key = m.b FROM m
      WHERE kin_pulse_nudges.rowid = m.a AND kin_pulse_nudges.org_id = ${orgId}`;
  return entries;
});
