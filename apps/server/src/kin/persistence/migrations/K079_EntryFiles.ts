import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Files the owner brought in with an import, kept on their entry with no chat behind them: only
 * the org's owner reads them. Keyed by the import row they came from, so a rerun adds none twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_entry_files (
    org_id TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    record_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, origin_key),
    UNIQUE (org_id, record_id, attachment_id),
    FOREIGN KEY (org_id, record_id) REFERENCES kin_records(org_id, record_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_entry_files_attachment
    ON kin_entry_files (org_id, attachment_id)`;
});
