import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Written by the server when it activates a key; see `approvals/KeySeal.ts`.
  yield* sql`ALTER TABLE kin_approver_keys ADD COLUMN seal TEXT`;
  // Sessions a pairing credential was exchanged for. Environment-local, like `kin_auth_session_keys`.
  yield* sql`CREATE TABLE kin_auth_paired_sessions (
    session_id TEXT PRIMARY KEY,
    via TEXT NOT NULL,
    pairing_link_id TEXT,
    created_at INTEGER NOT NULL
  )`;
  const auth =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'`;
  if (auth.length === 0) return;
  // `t3 auth session issue` writes no client address and never a DPoP session; every exchange over
  // HTTP records the caller's address, and relay renewals are DPoP. MCP clients aren't paired.
  yield* sql`INSERT INTO kin_auth_paired_sessions (session_id, via, created_at)
    SELECT session_id, 'migration', CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)
    FROM auth_sessions
    WHERE revoked_at IS NULL AND subject != 'mcp-client'
      AND (client_ip_address IS NOT NULL OR method = 'dpop-access-token')
    ORDER BY session_id
    ON CONFLICT (session_id) DO NOTHING`;
});
