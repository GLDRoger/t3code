import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Generated documents: a worker job made from a recipe, with what the server gave it and where
 * its result was filed; numbers a list issues, one series per prefix and financial year; and the
 * attachment a file version holds, so serving it is one indexed lookup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_doc_jobs (
    org_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('document', 'recipe')),
    recipe TEXT,
    recipe_commit TEXT NOT NULL,
    entry_record_id TEXT,
    inputs_sha256 TEXT NOT NULL,
    number TEXT,
    sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
    -- Where the job's docs are filed; the same recipe and entry, or the same inputs, version one doc.
    doc_origin TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    chat_id TEXT,
    audience TEXT NOT NULL CHECK (audience IN ('owner_only', 'shared')),
    answered_message_id TEXT,
    answered_author_kind TEXT CHECK (answered_author_kind IN ('person', 'agent')),
    answered_author_id TEXT,
    created_at INTEGER NOT NULL,
    collected_at INTEGER,
    outcome_json TEXT,
    PRIMARY KEY (org_id, worker_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_number_series (
    org_id TEXT NOT NULL,
    register_id TEXT NOT NULL,
    series TEXT NOT NULL,
    last_seq INTEGER NOT NULL CHECK (last_seq >= 1),
    PRIMARY KEY (org_id, register_id, series)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_issued_numbers (
    org_id TEXT NOT NULL,
    register_id TEXT NOT NULL,
    series TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    number TEXT NOT NULL,
    record_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    issued_by_kind TEXT NOT NULL CHECK (issued_by_kind IN ('person', 'agent')),
    issued_by_id TEXT NOT NULL,
    PRIMARY KEY (org_id, register_id, series, seq),
    UNIQUE (org_id, record_id),
    UNIQUE (org_id, register_id, number),
    FOREIGN KEY (org_id, record_id) REFERENCES kin_records(org_id, record_id)
  )`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_doc_versions)`;
  if (!columns.some((column) => column.name === "file_attachment_id"))
    yield* sql`ALTER TABLE kin_doc_versions ADD COLUMN file_attachment_id TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_doc_versions_file
    ON kin_doc_versions (file_attachment_id) WHERE file_attachment_id IS NOT NULL`;
});
