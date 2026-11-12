import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The files a doc's markdown shows: images it points at by `kin-file:` and the pages of its
 * `kin_visual` blocks, each kept once per doc by the page's hash. Readers of the doc read them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_doc_files (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    record_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    mime_type TEXT,
    page_sha256 TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, record_id, attachment_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_doc_files_attachment ON kin_doc_files (attachment_id)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_doc_files_page
    ON kin_doc_files (org_id, record_id, page_sha256) WHERE page_sha256 IS NOT NULL`;
});
