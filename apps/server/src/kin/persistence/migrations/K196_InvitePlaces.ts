import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** What a new teammate sees once they join, chosen with their invite; null keeps the usual start. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('kin_people_invites') WHERE name = 'sees_json'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_people_invites ADD COLUMN sees_json TEXT`;
});
