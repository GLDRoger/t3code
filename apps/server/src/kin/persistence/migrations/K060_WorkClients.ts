import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The light CRM lives in `kin_records` as three more built-in lists (clients, contacts,
 * projects), so it needs no table of its own. An entry gains the repository its issue is in, and
 * the pages read a list's open entries and an entry's repository by index.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_records)`;
  if (!columns.some((column) => column.name === "repo"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN repo TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_register
    ON kin_records (org_id, register_id, state, due_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_repo ON kin_records (org_id, repo)
    WHERE repo IS NOT NULL`;
});
