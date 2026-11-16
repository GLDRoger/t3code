import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When a person was removed from the company, cleared when a link lets them back in: an agent
 * gives no task to, nudges and names no one removed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_people') WHERE name = 'removed_at'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_people ADD COLUMN removed_at INTEGER`;
});
