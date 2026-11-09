import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Set right before the owner write; null means nothing was sent (spec section 6).
  yield* sql`ALTER TABLE kin_executions ADD COLUMN write_started_at INTEGER`;
});
