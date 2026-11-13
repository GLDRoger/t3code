import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A statement a lead reads: its pages' text, kept from the read until the review card is posted,
 * the rows the lead has given so far, page by page, and how many times Kin's check sent it back.
 * Status `scanned` now means a lead reads the rows: a scan, or a text PDF Kin couldn't prove.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_bank_statements)`;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("pages_json")) yield* sql`ALTER TABLE kin_bank_statements ADD COLUMN pages_json TEXT`;
  if (!has("draft_json")) yield* sql`ALTER TABLE kin_bank_statements ADD COLUMN draft_json TEXT`;
  if (!has("proof_rounds"))
    yield* sql`ALTER TABLE kin_bank_statements ADD COLUMN proof_rounds INTEGER NOT NULL DEFAULT 0`;
});
