import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who marked an entry private, so they keep seeing it and may take the mark off again. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_records') WHERE name = 'marked_by_person_id'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_records ADD COLUMN marked_by_person_id TEXT`;
});
