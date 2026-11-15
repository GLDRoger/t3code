import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Several accounts of one service. `note`: the owner's one line on what an account is for, shown
 * to agents. `send_as_json`: a mail account's own From addresses, as Gmail lists them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_connections')`).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("note")) yield* sql`ALTER TABLE kin_connections ADD COLUMN note TEXT`;
  if (!columns.has("send_as_json"))
    yield* sql`ALTER TABLE kin_connections ADD COLUMN send_as_json TEXT`;
});
