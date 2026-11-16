import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The account a send card showed, and the connection's sign-in generation when it was made: a
 * sign-in whose account Kin couldn't confirm moves the generation, so no card made before it
 * sends with the new credentials. Open and sending cards take their connection's account now.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const has = (table: string, column: string) =>
    sql<{ name: string }>`SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  if (!(yield* has("kin_connections", "sign_in_gen")))
    yield* sql`ALTER TABLE kin_connections ADD COLUMN sign_in_gen INTEGER NOT NULL DEFAULT 0`;
  if (!(yield* has("kin_connection_asks", "account"))) {
    yield* sql`ALTER TABLE kin_connection_asks ADD COLUMN account TEXT`;
    yield* sql`ALTER TABLE kin_connection_asks ADD COLUMN sign_in_gen INTEGER NOT NULL DEFAULT 0`;
    yield* sql`UPDATE kin_connection_asks SET account = (SELECT c.account_label
        FROM kin_connections c WHERE c.org_id = kin_connection_asks.org_id
          AND c.connection_id = kin_connection_asks.connection_id)`;
  }
});
