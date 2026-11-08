import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_auth_session_keys (
    session_id TEXT PRIMARY KEY,
    proof_key_thumbprint TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX kin_auth_session_keys_thumbprint ON kin_auth_session_keys(proof_key_thumbprint)`;
  yield* sql`CREATE TABLE kin_auth_key_repairs (session_id TEXT PRIMARY KEY)`;
});
