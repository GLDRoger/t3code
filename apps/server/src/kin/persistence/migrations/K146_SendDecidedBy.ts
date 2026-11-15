import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who confirmed a send, so an agent reading what went out can say who let it go. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_connection_asks') WHERE name = 'decided_by'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_connection_asks ADD COLUMN decided_by TEXT`;
});
