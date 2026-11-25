import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Kin's GitHub webhook sources left with its GitHub App (K166); nothing reads them any more. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS kin_webhook_sources`;
});
