import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A recipe revision's label, decided by the server from the job that wrote it, and the request a
 * rendered document's job was made for, so a reused request id can't return another's outcome.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_recipe_labels (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    recipe TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
    cleared_by_person_id TEXT,
    labelled_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, recipe, commit_sha)
  )`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_doc_jobs)`;
  if (!columns.some((column) => column.name === "request_sha256"))
    yield* sql`ALTER TABLE kin_doc_jobs ADD COLUMN request_sha256 TEXT`;
});
