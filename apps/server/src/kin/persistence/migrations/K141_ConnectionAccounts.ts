import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Several accounts of one service. `note`: the owner's one line on what an account is for, shown
 * to agents. `send_as_json`: a mail account's own From addresses, as its provider lists them.
 * Kin's own mail tools lose the "gmail_" prefix, so every mail provider shares their names; the
 * next listing re-pins their wording, which Kin accepts for its own tools.
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
  for (const table of ["kin_connection_tools", "kin_connection_asks"])
    yield* sql`UPDATE ${sql(table)} SET tool_name = 'mail_' || substr(tool_name, 7)
      WHERE tool_name LIKE 'gmail!_%' ESCAPE '!' AND connection_id IN
        (SELECT connection_id FROM kin_connections WHERE kind = 'builtin')`;
});
