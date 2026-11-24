import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A person may have several own mailboxes: the one-per-person index goes. An address stays live
 * once per company (`kin_connections_live_account`); rows are untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS kin_connections_live_person`;
});
