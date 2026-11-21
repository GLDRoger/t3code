import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Entries by their name in any case, which every same-name check reads; and an import check's
 * own run row, so how far a check has got is read as an import's is.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_title
    ON kin_records (org_id, register_id, lower(title))`;
  const [table] = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'kin_import_runs'`;
  if (table === undefined || table.sql.includes("'check'")) return;
  // SQLite can't widen a CHECK in place: the table is rebuilt, and keeps its rows and sequence.
  yield* sql`CREATE TABLE kin_import_runs_next (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    batch TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('apply', 'undo', 'check')),
    person_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    lists_json TEXT NOT NULL DEFAULT '[]',
    summary_json TEXT
  )`;
  yield* sql`INSERT INTO kin_import_runs_next (seq, org_id, batch, action, person_id, started_at,
      finished_at, lists_json, summary_json)
    SELECT seq, org_id, batch, action, person_id, started_at, finished_at, lists_json, summary_json
    FROM kin_import_runs ORDER BY seq`;
  const [last] = yield* sql<{ seq: number }>`SELECT seq FROM sqlite_sequence
    WHERE name = 'kin_import_runs'`;
  yield* sql`DROP TABLE kin_import_runs`;
  yield* sql`ALTER TABLE kin_import_runs_next RENAME TO kin_import_runs`;
  if (last !== undefined) {
    yield* sql`DELETE FROM sqlite_sequence WHERE name = 'kin_import_runs'`;
    yield* sql`INSERT INTO sqlite_sequence (name, seq) VALUES ('kin_import_runs', ${last.seq})`;
  }
});
