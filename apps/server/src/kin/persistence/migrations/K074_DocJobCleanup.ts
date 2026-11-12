import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A document job's worktree, inputs included, stays owed for removal until Kin has seen it gone:
 * `removed_at` is null until then, whatever ended the job.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_doc_jobs)`;
  if (!columns.some((column) => column.name === "removed_at"))
    yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN removed_at INTEGER`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_doc_jobs_to_remove
    ON kin_doc_jobs (removed_at) WHERE removed_at IS NULL`;
});
