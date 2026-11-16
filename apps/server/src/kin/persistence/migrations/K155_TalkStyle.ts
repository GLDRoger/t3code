import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** How each person likes to be spoken to, in their own words, for every agent's turn. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_people') WHERE name = 'talk_style'`;
  if (columns.length === 0)
    yield* sql`ALTER TABLE kin_people ADD COLUMN talk_style TEXT NOT NULL DEFAULT ''`;
});
