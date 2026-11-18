import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Signs out the devices given and every device linked from them, down the line, and cancels the
 * links any of them left open. The walk starts from the devices given whatever state their own
 * sessions are in, and each step stays with the same person in the same company. Plain expiry
 * doesn't cascade: a laptop in daily use stays when the phone that linked it sits idle.
 */
export const revokeLinkedDevices = Effect.fn("KinLinkedDevices.revoke")(function* (
  sql: SqlClient.SqlClient,
  from: ReadonlyArray<string>,
  /** The session asking, which never signs itself out. */
  keep: string | null = null,
) {
  if (from.length === 0) return [];
  // The CLI can revoke before Kin's migrations have added the device tree.
  const tree =
    yield* sql`SELECT 1 FROM pragma_table_info('kin_session_bindings') WHERE name = 'parent_session_id'`;
  if (tree.length === 0) return [];
  const now = yield* DateTime.now;
  const gone = (columns: ReturnType<typeof sql.literal>) =>
    sql`WITH RECURSIVE gone(session_id, org_id, person_id) AS (
      SELECT session_id, org_id, person_id FROM kin_session_bindings
        WHERE session_id IN ${sql.in(from)}
      UNION SELECT b.session_id, b.org_id, b.person_id FROM kin_session_bindings b JOIN gone g
        ON b.parent_session_id = g.session_id AND b.org_id = g.org_id AND b.person_id = g.person_id
    ) SELECT ${columns} FROM gone`;
  yield* sql`UPDATE kin_people_invites SET revoked_at = ${now.epochMilliseconds}
    WHERE consumed_at IS NULL AND revoked_at IS NULL
    AND (org_id, made_by_person_id, made_by_session_id)
      IN (${gone(sql.literal("org_id, person_id, session_id"))})`;
  yield* sql`UPDATE kin_session_bindings SET revoked_at = ${now.epochMilliseconds}
    WHERE revoked_at IS NULL AND session_id IS NOT ${keep}
    AND (session_id, org_id) IN (${gone(sql.literal("session_id, org_id"))})`;
  const signedOut = yield* sql<{ session_id: string }>`UPDATE auth_sessions
    SET revoked_at = ${DateTime.formatIso(now)}
    WHERE revoked_at IS NULL AND session_id IS NOT ${keep}
    AND session_id IN (${gone(sql.literal("session_id"))}) RETURNING session_id`;
  return signedOut.map((row) => row.session_id);
});
