import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The phone's 6-digit code, kept where the host's `kin approvals confirm-key` CLI can consume it.
// `verifier` is an HMAC over the row's tuple and the code, so a row written into SQLite can't pass.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE kin_approver_key_confirmations (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      thumbprint TEXT NOT NULL,
      session_id TEXT NOT NULL,
      challenge_sha256 TEXT NOT NULL,
      verifier TEXT NOT NULL,
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, thumbprint),
      FOREIGN KEY (org_id, thumbprint) REFERENCES kin_approver_keys(org_id, thumbprint)
    )
  `;
});
