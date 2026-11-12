import { KIN_SENSITIVE_FIELDS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Work and Docs search, in the database the rows live in. Each entry has a `public` row (title,
 * notes, its other fields, a doc's latest body) and, when it has any, a `sensitive` row of the
 * fields that are sensitive whatever its label. Labels are read at query time, so changing one
 * needs no reindex. `kin_search_rows` gives each row an INTEGER PRIMARY KEY, which VACUUM keeps.
 */

const sensitiveField = (sql: SqlClient.SqlClient) =>
  sql.or([
    ...Object.entries(KIN_SENSITIVE_FIELDS).map(
      ([list, fields]) => sql`(r.register_id = ${list} AND j.key IN ${sql.in(fields)})`,
    ),
    // A list the owner defined marks its own sensitive fields in its stored definition.
    sql`j.key IN (SELECT json_extract(f.value, '$.key') FROM kin_registers g,
      json_each(g.definition_json, '$.fields') f
      WHERE g.org_id = r.org_id AND g.register_id = r.register_id
        AND json_extract(f.value, '$.sensitive') = 1)`,
  ]);
const fieldText = (sql: SqlClient.SqlClient, sensitive: boolean) =>
  sql`COALESCE((SELECT group_concat(j.value, ' ') FROM json_each(r.fields_json) j
    WHERE ${sensitive ? sensitiveField(sql) : sql`NOT ${sensitiveField(sql)}`}), '')`;
const latestBody = (sql: SqlClient.SqlClient) => sql`COALESCE((SELECT v.body FROM kin_doc_versions v
    WHERE v.org_id = r.org_id AND v.record_id = r.record_id ORDER BY v.version DESC LIMIT 1), '')`;

/** Whether this host's SQLite had FTS5 when Kin's migrations ran; without it search scans. */
export const searchIndexed = Effect.fn("KinSearch.indexed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kin_search'`;
  return rows.length > 0;
});

/** Rewrites one entry's rows from what is stored now: call it inside the write's transaction. */
export const indexRecord = Effect.fn("KinSearch.indexRecord")(function* (
  orgId: string,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* searchIndexed())) return;
  yield* sql`DELETE FROM kin_search WHERE rowid IN (SELECT id FROM kin_search_rows
    WHERE org_id = ${orgId} AND record_id = ${recordId})`;
  yield* indexWhere(sql, sql`r.org_id = ${orgId} AND r.record_id = ${recordId}`);
});

/** Indexes every entry `where` selects (alias `r`); the migration backfills with it. */
export const indexWhere = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  where: ReturnType<SqlClient.SqlClient["and"]>,
) {
  yield* sql`INSERT INTO kin_search_rows (org_id, record_id, part)
    SELECT r.org_id, r.record_id, p.part FROM kin_records r
    CROSS JOIN (SELECT 'public' AS part UNION ALL SELECT 'sensitive') p WHERE ${where}
    ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO kin_search (rowid, title, body)
    SELECT m.id, r.title, r.notes || ' ' || ${fieldText(sql, false)} || ' ' || ${latestBody(sql)}
    FROM kin_records r JOIN kin_search_rows m ON m.org_id = r.org_id
      AND m.record_id = r.record_id AND m.part = 'public'
    WHERE ${where}`;
  yield* sql`INSERT INTO kin_search (rowid, title, body)
    SELECT m.id, '', ${fieldText(sql, true)}
    FROM kin_records r JOIN kin_search_rows m ON m.org_id = r.org_id
      AND m.record_id = r.record_id AND m.part = 'sensitive'
    WHERE ${where} AND ${fieldText(sql, true)} != ''`;
});
