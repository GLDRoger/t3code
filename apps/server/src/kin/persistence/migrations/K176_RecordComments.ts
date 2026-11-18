import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `seq` orders one record's comments; `request_hash` makes a retry return the stored comment.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_record_comments (
    org_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
    author_id TEXT NOT NULL,
    asked_by_person_id TEXT,
    body TEXT NOT NULL,
    files_json TEXT NOT NULL DEFAULT '[]',
    request_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    removed_by_kind TEXT CHECK (removed_by_kind IN ('person', 'agent')),
    removed_by_id TEXT,
    PRIMARY KEY (org_id, comment_id),
    UNIQUE (org_id, record_id, seq)
  )`;
  // A comment's files, by id: the file server asks whether one is on a comment its reader sees.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_record_comment_files (
    org_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    PRIMARY KEY (org_id, attachment_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_record_comment_files_attachment
    ON kin_record_comment_files (attachment_id)`;
  const records = yield* sql<{ name: string }>`PRAGMA table_info(kin_records)`;
  if (!records.some((column) => column.name === "asked_by_person_id"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN asked_by_person_id TEXT`;
  const changes = yield* sql<{ name: string }>`PRAGMA table_info(kin_record_changes)`;
  if (!changes.some((column) => column.name === "asked_by_person_id"))
    yield* sql`ALTER TABLE kin_record_changes ADD COLUMN asked_by_person_id TEXT`;
});
