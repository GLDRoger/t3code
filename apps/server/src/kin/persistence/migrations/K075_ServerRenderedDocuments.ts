import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Documents the server renders itself: a job row keeps what the requester gave and the title,
 * so issuing the entry can make the document again in place, and the owner when they asked.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_doc_jobs)`;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("given_json")) yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN given_json TEXT`;
  if (!has("title")) yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN title TEXT`;
  if (!has("asked_by_person_id"))
    yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN asked_by_person_id TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_doc_jobs_entry
    ON kin_doc_jobs (org_id, entry_record_id, doc_origin, created_at)
    WHERE given_json IS NOT NULL`;
});
