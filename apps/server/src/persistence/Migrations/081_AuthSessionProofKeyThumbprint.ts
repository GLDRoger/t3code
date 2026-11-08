import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN proof_key_thumbprint TEXT`;
  yield* sql`CREATE INDEX idx_auth_sessions_proof_key ON auth_sessions(proof_key_thumbprint)`;
});
