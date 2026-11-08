import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_secret_allow (
    org_id TEXT NOT NULL,
    path TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
    signed_action_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, path, rule_id, fingerprint)
  )`;
});
