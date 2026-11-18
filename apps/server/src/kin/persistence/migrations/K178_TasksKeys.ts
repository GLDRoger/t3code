import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A person's coding-agent keys. Not `kin_session_bindings`: a key is never a person's app session.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_tasks_keys (
    session_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_tasks_keys_person
    ON kin_tasks_keys (org_id, person_id, created_at)`;
  // The key a change or comment came through, when a person's coding agent made it.
  const changes = yield* sql<{ name: string }>`PRAGMA table_info(kin_record_changes)`;
  if (!changes.some((column) => column.name === "coding_agent_key"))
    yield* sql`ALTER TABLE kin_record_changes ADD COLUMN coding_agent_key TEXT`;
  const comments = yield* sql<{ name: string }>`PRAGMA table_info(kin_record_comments)`;
  if (!comments.some((column) => column.name === "coding_agent_key"))
    yield* sql`ALTER TABLE kin_record_comments ADD COLUMN coding_agent_key TEXT`;
});
