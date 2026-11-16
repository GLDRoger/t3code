import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When a message's reply posted, set the moment it posts: a restart or a later failure in the
 * turn never asks the agent to answer it again, nor tells the asker it stopped partway.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_events') WHERE name = 'replied_at'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_events ADD COLUMN replied_at INTEGER`;
});
