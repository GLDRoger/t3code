import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** An agent's check-in or weekly brief, kept on its reply so every client draws it as one. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_messages') WHERE name = 'form'`;
  if (columns.length === 0)
    yield* sql`ALTER TABLE kin_messages ADD COLUMN form TEXT CHECK (form IS NULL OR form = 'brief')`;
});
