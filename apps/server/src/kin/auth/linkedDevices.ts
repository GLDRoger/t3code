import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Signs out every device linked, down the line, from sessions just revoked, and cancels the links
 * they left open; each revocation runs it in its own transaction. Plain expiry doesn't cascade:
 * a laptop in daily use stays when the phone that linked it sits idle.
 */
export const revokeLinkedDevices = Effect.fn("KinLinkedDevices.revoke")(function* (
  sql: SqlClient.SqlClient,
  revoked: ReadonlyArray<string>,
  /** The session asking, which never signs itself out. */
  keep: string | null = null,
) {
  if (revoked.length === 0) return [];
  // The CLI can revoke before Kin's migrations have added the device tree.
  const tree =
    yield* sql`SELECT 1 FROM pragma_table_info('kin_session_bindings') WHERE name = 'parent_session_id'`;
  if (tree.length === 0) return [];
  const now = yield* DateTime.now;
  const gone = sql`WITH RECURSIVE gone(session_id) AS (
      SELECT session_id FROM kin_session_bindings WHERE parent_session_id IN ${sql.in(revoked)}
      UNION SELECT b.session_id FROM kin_session_bindings b JOIN gone g
        ON b.parent_session_id = g.session_id
    ) SELECT session_id FROM gone WHERE session_id IS NOT ${keep}`;
  yield* sql`UPDATE kin_people_invites SET revoked_at = ${now.epochMilliseconds}
    WHERE consumed_at IS NULL AND revoked_at IS NULL
    AND (made_by_session_id IN ${sql.in(revoked)} OR made_by_session_id IN (${gone}))`;
  yield* sql`UPDATE kin_session_bindings SET revoked_at = ${now.epochMilliseconds}
    WHERE revoked_at IS NULL AND session_id IN (${gone})`;
  const signedOut = yield* sql<{ session_id: string }>`UPDATE auth_sessions
    SET revoked_at = ${DateTime.formatIso(now)}
    WHERE revoked_at IS NULL AND session_id IN (${gone}) RETURNING session_id`;
  return signedOut.map((row) => row.session_id);
});
