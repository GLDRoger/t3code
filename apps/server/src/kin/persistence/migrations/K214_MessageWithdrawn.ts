import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Why and when an agent took back one of its messages before anyone read it (`withdrawn_json`,
 * `{"why", "at"}`); the message keeps its words and turns `deleted`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  if (!columns.some((column) => column.name === "withdrawn_json"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN withdrawn_json TEXT`;
});
