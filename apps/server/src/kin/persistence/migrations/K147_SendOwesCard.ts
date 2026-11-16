import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A failed or outdated mail still owed its new card, set in the transaction that records the
 * failure: a restart before that card posts makes it at start instead of losing the mail.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_connection_asks') WHERE name = 'owes_card'`;
  if (columns.length === 0)
    yield* sql`ALTER TABLE kin_connection_asks ADD COLUMN owes_card INTEGER NOT NULL DEFAULT 0`;
});
