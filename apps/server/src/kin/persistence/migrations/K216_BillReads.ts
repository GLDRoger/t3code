import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bills added in bulk: one row per file's bytes in a company, from the moment it is added, through
 * its one read to the suggested expense made for it. Whether that expense was kept or dropped is
 * read from the record. Retried writes keep their first answer in `kin_bill_requests`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bill_reads (
    org_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    name TEXT NOT NULL,
    file_type TEXT NOT NULL CHECK (file_type IN ('image', 'file')),
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    batch_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    card_chat_id TEXT NOT NULL,
    widget_id TEXT NOT NULL,
    added_by_person_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'reading', 'read', 'duplicate', 'unreadable')),
    event_id TEXT,
    reads INTEGER NOT NULL DEFAULT 0,
    read_json TEXT,
    problem TEXT,
    duplicate_of TEXT,
    record_id TEXT,
    read_at INTEGER,
    dismissed_at INTEGER,
    PRIMARY KEY (org_id, sha256)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_bill_reads_batch
    ON kin_bill_reads (org_id, batch_id, position)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_bill_reads_attachment
    ON kin_bill_reads (org_id, attachment_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_bill_reads_event
    ON kin_bill_reads (org_id, event_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bill_requests (
    org_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, person_id, kind, request_id)
  )`;
});
