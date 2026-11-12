import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each `kin import` apply and undo, who ran it and what it did: the record of a batch that
 * outlives the entries an undo removes, and the lists an apply made, which only it can say.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_import_runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    batch TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('apply', 'undo')),
    person_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    lists_json TEXT NOT NULL DEFAULT '[]',
    summary_json TEXT
  )`;
});
