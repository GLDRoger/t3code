import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The names Kin wrote over an agent's entry keys, so they still link; and a disagreement card an
 * agent-started discussion holds for the owner's next note. What a discussion changed is read
 * from the record changes now, so its own list goes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const has = (table: string, column: string) =>
    sql<{ name: string }>`SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  yield* sql`CREATE TABLE IF NOT EXISTS kin_message_names (
    org_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    names_json TEXT NOT NULL,
    PRIMARY KEY (org_id, message_id)
  )`;
  if (!(yield* has("kin_discussions", "card_json")))
    yield* sql`ALTER TABLE kin_discussions ADD COLUMN card_json TEXT`;
  if (yield* has("kin_discussions", "did_json"))
    yield* sql`ALTER TABLE kin_discussions DROP COLUMN did_json`;
});
