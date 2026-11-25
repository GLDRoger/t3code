import type { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Signs out the devices given and every device linked from them, down the line, and ends the links
 * and coding-agent keys any of them made. The walk ignores their own sessions' state and stays with
 * one person in one company. Expiry doesn't cascade: an idle phone never ends the laptop it linked.
 * Returns the sessions it signed out and the companies whose devices or keys it ended.
 */
export const revokeLinkedDevices = Effect.fn("KinLinkedDevices.revoke")(function* (
  sql: SqlClient.SqlClient,
  from: ReadonlyArray<string>,
  /** The session asking, which never signs itself out. */
  keep: string | null = null,
) {
  const none = { signedOut: [], orgs: [] };
  if (from.length === 0) return none;
  // The CLI can revoke before Kin's migrations have added the device tree or the keys' makers.
  const added = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_session_bindings')
        WHERE name = 'parent_session_id'
      UNION ALL SELECT name FROM pragma_table_info('kin_tasks_keys')
        WHERE name = 'made_by_session_id'`).map((column) => column.name),
  );
  if (!added.has("parent_session_id")) return none;
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
  const devices = yield* sql<{
    org_id: KinOrgId;
  }>`UPDATE kin_session_bindings SET revoked_at = ${now.epochMilliseconds}
    WHERE revoked_at IS NULL AND session_id IS NOT ${keep}
    AND (session_id, org_id) IN (${gone(sql.literal("session_id, org_id"))})
    RETURNING org_id`;
  // No org filter: a session is one person's in one company, and a key's maker is its own session.
  const keys = added.has("made_by_session_id")
    ? yield* sql<{
        session_id: string;
        org_id: KinOrgId;
      }>`UPDATE kin_tasks_keys SET revoked_at = ${now.epochMilliseconds}
      WHERE revoked_at IS NULL AND made_by_session_id IS NOT ${keep}
      AND (made_by_session_id IN ${sql.in(from)}
        OR made_by_session_id IN (${gone(sql.literal("session_id"))}))
      RETURNING session_id, org_id`
    : [];
  const signedOut = yield* sql<{ session_id: string }>`UPDATE auth_sessions
    SET revoked_at = ${DateTime.formatIso(now)}
    WHERE revoked_at IS NULL AND session_id IS NOT ${keep}
    AND (session_id IN (${gone(sql.literal("session_id"))})
      OR session_id IN ${sql.in(keys.map((key) => key.session_id))})
    RETURNING session_id`;
  return {
    signedOut: signedOut.map((row) => row.session_id),
    orgs: [...new Set([...devices, ...keys].map((row) => row.org_id))],
  };
});
