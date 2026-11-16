import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { workFailure } from "./recordRows.ts";
import { searchIndexed } from "./searchIndex.ts";

const CHUNK = 100;
const MAX_LISTED = 2_000;
const BATCH = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeLists = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

export type UndoReport = {
  readonly batch: string;
  readonly applied: boolean;
  readonly includeChanged: boolean;
  readonly removes: {
    readonly clients: number;
    readonly projects: number;
    readonly entries: number;
    readonly payments: number;
  };
  /** Keys imported, then changed by someone; kept unless asked to include them. */
  readonly changed: ReadonlyArray<string>;
  /** Imported rows kept because something outside the batch uses or paid them, and what. */
  readonly kept: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
  readonly lists: ReadonlyArray<{
    readonly list: string;
    readonly action: "remove" | "keep";
    readonly entries: number;
  }>;
};

const PAID_IN_KIN = "a payment recorded in Kin is on it";
const numberedIn = (number: string) => `Kin issued it ${number}, which stays in its series`;

/**
 * Entries of `ids` holding a number Kin issued or adopted itself, not one the import kept: the
 * number's change is logged by someone other than the import. Nothing takes those away.
 */
const kinNumbered = (sql: SqlClient.SqlClient, orgId: KinOrgId, ids: Statement.Fragment) =>
  sql<{ id: string; number: string }>`SELECT n.record_id AS id, n.number FROM kin_issued_numbers n
    WHERE n.org_id = ${orgId} AND n.record_id IN ${ids}
      AND EXISTS (SELECT 1 FROM kin_record_changes c, json_each(c.fields_json) f
        WHERE c.org_id = n.org_id AND c.record_id = n.record_id AND c.via <> 'import'
          AND json_extract(f.value, '$.field') = 'number')
    ORDER BY n.record_id`;
/** Entries go before the projects and clients they point at, so a late keep strands nothing. */
const ORDER: Record<string, number> = { entry: 0, project: 1, client: 2 };

const batchRange = (sql: SqlClient.SqlClient, batch: string) => {
  // `;` sorts right after `:`, so the range is every key with this batch's prefix.
  const from = `import:${batch}:`;
  const to = `import:${batch};`;
  return {
    from,
    inBatch: (column: string) => sql`${sql(column)} >= ${from} AND ${sql(column)} < ${to}`,
  };
};

/**
 * What outside the removal points at `ids`: their client or project, a link, a link field, a
 * generated document (`by` null). Each keeps its target.
 */
const usersOf = (sql: SqlClient.SqlClient, orgId: KinOrgId, ids: Statement.Fragment) =>
  sql<{ target: string; by: string | null; byKey: string | null }>`
    SELECT r.party_id AS target, r.record_id AS "by", r.key AS "byKey" FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.party_id IN ${ids}
    UNION ALL SELECT r.project_id, r.record_id, r.key FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.project_id IN ${ids}
    UNION ALL SELECT l.target, l.record_id, r.key FROM kin_record_links l
      JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
      WHERE l.org_id = ${orgId} AND l.kind = 'record' AND l.target IN ${ids}
    UNION ALL SELECT j.value, r.record_id, r.key FROM kin_records r, json_each(r.fields_json) j
      WHERE r.org_id = ${orgId} AND j.type = 'text' AND j.value IN ${ids}
    UNION ALL SELECT d.entry_record_id, NULL, NULL FROM kin_doc_jobs d
      WHERE d.org_id = ${orgId} AND d.entry_record_id IN ${ids}`;

/**
 * Deletes one chunk of a batch's rows in one transaction. What to keep is worked out again inside
 * it, so a payment, change or use made while the undo runs keeps its row; those are returned and
 * taken out of `removing`.
 */
export const removeChunk = Effect.fn("KinImport.removeChunk")(function* (
  orgId: KinOrgId,
  batch: string,
  chunk: ReadonlyArray<string>,
  removing: Set<string>,
  options: { readonly includeChanged: boolean; readonly indexed: boolean },
) {
  const sql = yield* SqlClient.SqlClient;
  const { inBatch } = batchRange(sql, batch);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const asked = sql.in(chunk);
      const held = new Set(
        (yield* sql<{ id: string }>`SELECT p.record_id AS id FROM kin_record_payments p
          WHERE p.org_id = ${orgId} AND p.record_id IN ${asked} AND NOT (${inBatch("p.origin_key")})
          UNION SELECT n.id FROM (${kinNumbered(sql, orgId, sql`${asked}`)}) n
          ${
            options.includeChanged
              ? sql``
              : sql`UNION SELECT c.record_id FROM kin_record_changes c
                WHERE c.org_id = ${orgId} AND c.via <> 'import' AND c.record_id IN ${asked}`
          }`).map((one) => one.id),
      );
      const refs = yield* usersOf(sql, orgId, sql`${asked}`);
      let moved = true;
      while (moved) {
        moved = false;
        for (const ref of refs) {
          if (held.has(ref.target) || ref.by === ref.target) continue;
          if (ref.by !== null && removing.has(ref.by) && !held.has(ref.by)) continue;
          held.add(ref.target);
          moved = true;
        }
      }
      for (const id of held) removing.delete(id);
      const gone = chunk.filter((id) => !held.has(id));
      if (gone.length > 0) {
        const these = sql.in(gone);
        if (options.indexed)
          yield* sql`DELETE FROM kin_search WHERE rowid IN (SELECT id FROM kin_search_rows
            WHERE org_id = ${orgId} AND record_id IN ${these})`;
        yield* sql`DELETE FROM kin_search_rows WHERE org_id = ${orgId} AND record_id IN ${these}`;
        yield* sql`DELETE FROM kin_record_links WHERE org_id = ${orgId} AND record_id IN ${these}`;
        yield* sql`DELETE FROM kin_record_payments WHERE org_id = ${orgId} AND record_id IN ${these}`;
        // Its number goes with it; the series stays where it is, so none is issued twice.
        yield* sql`DELETE FROM kin_issued_numbers WHERE org_id = ${orgId} AND record_id IN ${these}`;
        yield* sql`DELETE FROM kin_record_changes WHERE org_id = ${orgId} AND record_id IN ${these}`;
        yield* sql`DELETE FROM kin_records WHERE org_id = ${orgId} AND record_id IN ${these}`;
      }
      return chunk.filter((id) => held.has(id));
    }),
  );
});

/** Takes a batch away: what it made that nobody changed, paid in Kin or uses since, in chunks. */
export const undoBatch = Effect.fn("KinImport.undo")(function* (
  orgId: KinOrgId,
  owner: KinPersonId,
  batch: string,
  options: { readonly apply: boolean; readonly includeChanged: boolean },
) {
  const sql = yield* SqlClient.SqlClient;
  if (!BATCH.test(batch)) return yield* invalid(`${batch} isn't a batch name.`);
  const { from, inBatch } = batchRange(sql, batch);
  const rows = yield* sql<{
    recordId: string;
    key: string;
    registerId: string;
    originKey: string;
  }>`
    SELECT record_id AS "recordId", key, register_id AS "registerId", origin_key AS "originKey"
    FROM kin_records WHERE org_id = ${orgId} AND ${inBatch("origin_key")} ORDER BY origin_key`;
  const ids = sql`SELECT record_id FROM kin_records WHERE org_id = ${orgId} AND ${inBatch("origin_key")}`;
  // A payment Kin recorded is never the batch's to take: its entry stays, changed or not.
  const paid = new Set(
    (yield* sql<{ id: string }>`SELECT DISTINCT p.record_id AS id FROM kin_record_payments p
      WHERE p.org_id = ${orgId} AND p.record_id IN (${ids}) AND NOT (${inBatch("p.origin_key")})
      ORDER BY p.record_id`).map((one) => one.id),
  );
  const numbered = new Map(
    (yield* kinNumbered(sql, orgId, sql`(${ids})`)).map((one) => [one.id, one.number]),
  );
  const edited = new Set(
    (yield* sql<{ id: string }>`SELECT DISTINCT c.record_id AS id FROM kin_record_changes c
      WHERE c.org_id = ${orgId} AND c.via <> 'import' AND c.record_id IN (${ids})
      ORDER BY c.record_id`)
      .map((one) => one.id)
      .filter((id) => !paid.has(id) && !numbered.has(id)),
  );
  const removing = new Set(
    rows
      .filter(
        (one) =>
          !paid.has(one.recordId) &&
          !numbered.has(one.recordId) &&
          (options.includeChanged || !edited.has(one.recordId)),
      )
      .map((one) => one.recordId),
  );
  // Each user outside the removal keeps its target, and so on until nothing moves.
  const refs = yield* usersOf(sql, orgId, sql`(${ids})`);
  const keyOf = new Map(rows.map((one) => [one.recordId, one.key]));
  const users = new Map<string, Set<string>>();
  let moved = true;
  while (moved) {
    moved = false;
    for (const ref of refs) {
      if (!removing.has(ref.target) || (ref.by !== null && removing.has(ref.by))) continue;
      removing.delete(ref.target);
      moved = true;
    }
  }
  // Listed: what stays only because something kept uses it, not what someone changed.
  for (const ref of refs) {
    const { target, by } = ref;
    if (!keyOf.has(target) || removing.has(target) || by === target) continue;
    if ((edited.has(target) && !options.includeChanged) || (by !== null && removing.has(by)))
      continue;
    users.set(target, (users.get(target) ?? new Set()).add(ref.byKey ?? "a generated document"));
  }
  const kept = [...new Set([...paid, ...numbered.keys(), ...users.keys()])]
    .map((target) => {
      const by = users.get(target);
      const number = numbered.get(target);
      return {
        key: keyOf.get(target) ?? target,
        reason: [
          ...(paid.has(target) ? [PAID_IN_KIN] : []),
          ...(number === undefined ? [] : [numberedIn(number)]),
          ...(by === undefined
            ? []
            : [`${[...by].toSorted().join(", ")} ${by.size === 1 ? "uses" : "use"} it`]),
        ].join("; "),
      };
    })
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const kindOf = (originKey: string) => originKey.slice(from.length).split(":")[0] ?? "";
  const gone = rows
    .filter((one) => removing.has(one.recordId))
    .toSorted((a, b) => (ORDER[kindOf(a.originKey)] ?? 0) - (ORDER[kindOf(b.originKey)] ?? 0));
  const keptPaid = yield* sql<{ id: string; n: number }>`SELECT record_id AS id, COUNT(*) AS n
    FROM kin_record_payments WHERE org_id = ${orgId} AND record_id IN (${ids}) GROUP BY record_id`;
  const payments = keptPaid.reduce((sum, one) => sum + (removing.has(one.id) ? one.n : 0), 0);

  // The lists the batch made since it was last undone, and whether anything else is on them.
  const runs = yield* sql<{ action: string; lists: string }>`SELECT action, lists_json AS lists
    FROM kin_import_runs WHERE org_id = ${orgId} AND batch = ${batch} ORDER BY seq`;
  const made = new Set<string>();
  for (const one of runs) {
    if (one.action === "undo") made.clear();
    else for (const list of Option.getOrElse(decodeLists(one.lists), () => [])) made.add(list);
  }
  const lists: Array<UndoReport["lists"][number]> = [];
  for (const list of made) {
    const [held] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
      WHERE org_id = ${orgId} AND register_id = ${list}`;
    const left = (held?.n ?? 0) - gone.filter((one) => one.registerId === list).length;
    lists.push({ list, action: left === 0 ? "remove" : "keep", entries: left });
  }

  const report: UndoReport = {
    batch,
    applied: options.apply,
    includeChanged: options.includeChanged,
    removes: {
      clients: gone.filter((one) => kindOf(one.originKey) === "client").length,
      projects: gone.filter((one) => kindOf(one.originKey) === "project").length,
      entries: gone.filter((one) => kindOf(one.originKey) === "entry").length,
      payments,
    },
    changed: rows
      .filter((one) => edited.has(one.recordId))
      .map((one) => one.key)
      .slice(0, MAX_LISTED),
    kept: kept.slice(0, MAX_LISTED),
    lists,
  };
  if (!options.apply) return report;

  const indexed = yield* searchIndexed();
  const now = yield* Clock.currentTimeMillis;
  const late: Array<string> = [];
  for (let index = 0; index < gone.length; index += CHUNK) {
    const chunk = gone.slice(index, index + CHUNK).map((one) => one.recordId);
    late.push(
      ...(yield* removeChunk(orgId, batch, chunk, removing, {
        includeChanged: options.includeChanged,
        indexed,
      })),
    );
  }
  const stayed = new Set(late);
  const removed = gone.filter((one) => !stayed.has(one.recordId));
  const final: UndoReport =
    late.length === 0
      ? report
      : {
          ...report,
          removes: {
            clients: removed.filter((one) => kindOf(one.originKey) === "client").length,
            projects: removed.filter((one) => kindOf(one.originKey) === "project").length,
            entries: removed.filter((one) => kindOf(one.originKey) === "entry").length,
            payments: keptPaid.reduce((sum, one) => sum + (stayed.has(one.id) ? 0 : one.n), 0),
          },
          kept: [
            ...report.kept,
            ...late.map((id) => ({
              key: keyOf.get(id) ?? id,
              reason: "it changed while the undo ran",
            })),
          ].slice(0, MAX_LISTED),
        };
  const touched = [...new Set(gone.map((one) => one.registerId))];
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Keys past every entry still on a list were the batch's alone; the next entry reuses them.
      if (touched.length > 0)
        yield* sql`UPDATE kin_registers SET next_number = MIN(next_number, 1 + COALESCE((
            SELECT MAX(CAST(substr(r.key, length(rtrim(r.key, '0123456789')) + 1) AS INTEGER))
            FROM kin_records r
            WHERE r.org_id = kin_registers.org_id AND r.register_id = kin_registers.register_id
          ), 0))
          WHERE org_id = ${orgId} AND register_id IN ${sql.in(touched)}`;
      // A list's number series outlives it: defined again, the list carries on its numbers.
      for (const one of lists)
        if (one.action === "remove") {
          yield* sql`DELETE FROM kin_registers WHERE org_id = ${orgId} AND register_id = ${one.list}
            AND NOT EXISTS (SELECT 1 FROM kin_records WHERE org_id = ${orgId} AND register_id = ${one.list})`;
        }
      const finished = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO kin_import_runs (org_id, batch, action, person_id, started_at,
          finished_at, lists_json, summary_json)
        VALUES (${orgId}, ${batch}, 'undo', ${owner}, ${now}, ${finished},
          ${encodeJson(lists.filter((one) => one.action === "remove").map((one) => one.list))},
          ${encodeJson({ ...final.removes, changed: report.changed.length, kept: kept.length + late.length, includeChanged: options.includeChanged })})`;
    }),
  );
  return final;
}, workFailure);
