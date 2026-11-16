import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A recipe-writing job's references (the owner's files it may look at, never commit) and how many
 * passes it has had: each failed render or the one look at its page goes back to the worker.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_doc_jobs)`;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("references_json")) yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN references_json TEXT`;
  if (!has("passes"))
    yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN passes INTEGER NOT NULL DEFAULT 0`;
  if (!has("compared"))
    yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN compared INTEGER NOT NULL DEFAULT 0`;
});
