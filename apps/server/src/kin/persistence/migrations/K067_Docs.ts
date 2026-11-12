import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

import { indexWhere } from "../../work/searchIndex.ts";

/**
 * Docs: every version of a doc's body, kept whole, with its provenance from stored rows. A doc
 * itself is a `kin_records` row in the `docs` list. `file_json` waits for generated files.
 * Also the search index over entries and docs, and the doc references a message carries.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_doc_versions (
    org_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    body_kind TEXT NOT NULL DEFAULT 'markdown' CHECK (body_kind IN ('markdown', 'file')),
    body TEXT NOT NULL DEFAULT '',
    file_json TEXT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'rewritten', 'restored')),
    summary TEXT NOT NULL,
    operations_json TEXT NOT NULL,
    base_version INTEGER,
    restored_from INTEGER,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system')),
    actor_id TEXT,
    via TEXT NOT NULL,
    wakeup_id TEXT,
    chat_id TEXT,
    answered_message_id TEXT,
    answered_author_kind TEXT CHECK (answered_author_kind IN ('person', 'agent')),
    answered_author_id TEXT,
    audience TEXT CHECK (audience IN ('owner_only', 'shared')),
    worker_id TEXT,
    -- An identical retry finds the version it made instead of making another.
    origin_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, record_id, version),
    UNIQUE (org_id, origin_key),
    FOREIGN KEY (org_id, record_id) REFERENCES kin_records(org_id, record_id)
  )`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  if (!columns.some((column) => column.name === "refs_json"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN refs_json TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_search_rows (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    part TEXT NOT NULL CHECK (part IN ('public', 'sensitive')),
    UNIQUE (org_id, record_id, part)
  )`;
  const indexed = yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'kin_search'`;
  if (indexed.length > 0) return;
  // An SQLite without FTS5 fails with SQLITE_ERROR; search then scans. Other failures fail here,
  // so the next start retries.
  const created = yield* sql`CREATE VIRTUAL TABLE kin_search USING fts5(
      title, body, tokenize = 'unicode61 remove_diacritics 2')`.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning("Kin search index unavailable; search will scan.", cause).pipe(
          Effect.as(false),
        ),
    ),
  );
  if (created) yield* indexWhere(sql, sql.and([sql`1 = 1`]));
});
