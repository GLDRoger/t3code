import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Where "what is new" last stopped for each connection, in epoch ms. Sign-in tokens are not
 * here: they live in the server's secret store with the connection's other credentials.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_connection_cursors (
    org_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    checked_until INTEGER NOT NULL CHECK (checked_until >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, connection_id),
    FOREIGN KEY (org_id, connection_id) REFERENCES kin_connections(org_id, connection_id)
  )`;
});
