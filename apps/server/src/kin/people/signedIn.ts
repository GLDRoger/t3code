import type { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { accessSql } from "./KinAccess.ts";

/**
 * The people of an org with a live device session: who has signed in to Kin and can be reached
 * there now. The Team screen's "joined" and an agent's message to someone both read this; the
 * rest need a new invite link. The owner opens Kin from their own session, so callers add them.
 */
export const signedInPeople = Effect.fn("KinPeople.signedIn")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const rows = yield* sql<{ personId: KinPersonId }>`SELECT DISTINCT b.person_id AS "personId"
    FROM kin_session_bindings b
    JOIN auth_sessions a ON a.session_id = b.session_id
    WHERE b.org_id = ${orgId} AND b.revoked_at IS NULL AND a.revoked_at IS NULL
      AND a.expires_at > ${now}
    ORDER BY b.person_id`;
  return rows.map((row) => row.personId);
});

/** Whether this person has signed in: a live session, or the org's owner. */
export const signedIn = Effect.fn("KinPeople.isSignedIn")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* sql`SELECT 1 FROM kin_people p WHERE p.org_id = ${orgId}
    AND p.person_id = ${personId} AND ${sql.literal(accessSql("p"))} = 'owner' LIMIT 1`;
  return owner !== undefined || (yield* signedInPeople(orgId)).includes(personId);
});
