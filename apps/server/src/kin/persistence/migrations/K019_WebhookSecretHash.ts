import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // NULL refuses every delivery until Kin re-saves the secret it chose.
  yield* sql`ALTER TABLE kin_webhook_sources ADD COLUMN secret_sha256 TEXT`;
});
