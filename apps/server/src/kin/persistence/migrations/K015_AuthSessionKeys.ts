import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Auth sessions and key repairs are environment-local, not organization-scoped.
  yield* sql`CREATE TABLE kin_auth_session_keys (
    session_id TEXT PRIMARY KEY,
    proof_key_thumbprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    individually_revoked INTEGER NOT NULL DEFAULT 0,
    repaired_at INTEGER
  )`;
  yield* sql`CREATE INDEX kin_auth_session_keys_thumbprint ON kin_auth_session_keys(proof_key_thumbprint)`;
  yield* sql`CREATE TABLE kin_auth_key_repairs (thumbprint TEXT NOT NULL, pairing_link_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, consumed_at INTEGER)`;
});
