import type { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

/** The org owner owns one of its leads; the reserved bootstrap owner counts before any lead exists. */
export const isOrgOwner = Effect.fn("KinOrgState.isOrgOwner")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT 1 FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${personId}
      AND ((p.org_id = 'kin-default' AND p.person_id = 'kin-default-owner'
        AND NOT EXISTS (SELECT 1 FROM kin_leads WHERE org_id = p.org_id)) OR EXISTS (
        SELECT 1 FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = p.org_id AND a.owner_person_id = p.person_id))
      ORDER BY p.person_id`;
  return rows.length > 0;
});

/** The stop switch. Paused orgs start no wake-up, worker, dream or routine. */
export const isOrgPaused = Effect.fn("KinOrgState.isOrgPaused")(
  function* (orgId: KinOrgId) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT 1 FROM kin_org_state WHERE org_id = ${orgId} AND paused = 1 ORDER BY org_id`;
    return rows.length > 0;
  },
  Effect.mapError(toPersistenceSqlError("KinOrgState.isOrgPaused")),
);
