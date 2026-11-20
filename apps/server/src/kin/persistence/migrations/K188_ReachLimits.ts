import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Restricted pairs (`lead/Reach.ts`), sorted by (kind, id) to hold both ways. Hand revokes carry;
 * one at the person's removal instant is the removal's (`KinPeople`).
 * A hand revoke of a pair open anyway (team agent, owner-level) closed nothing then; not carried.
 * A removal revoke that reads as hand-set after a second Remove carries: closed, and liftable.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_reach_limits (
    limit_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    one_kind TEXT NOT NULL CHECK (one_kind IN ('agent', 'person')),
    one_id TEXT NOT NULL,
    other_kind TEXT NOT NULL CHECK (other_kind IN ('agent', 'person')),
    other_id TEXT NOT NULL,
    set_by_person_id TEXT NOT NULL REFERENCES kin_people(person_id),
    set_at INTEGER NOT NULL,
    lifted_by_person_id TEXT NULL REFERENCES kin_people(person_id),
    lifted_at INTEGER NULL,
    CHECK (one_kind < other_kind OR (one_kind = other_kind AND one_id < other_id)),
    CHECK ((lifted_at IS NULL) = (lifted_by_person_id IS NULL))
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_reach_limits_live
    ON kin_reach_limits (org_id, one_kind, one_id, other_kind, other_id)
    WHERE lifted_at IS NULL`;
  yield* sql`INSERT INTO kin_reach_limits (limit_id, org_id, one_kind, one_id, other_kind,
      other_id, set_by_person_id, set_at)
    SELECT 'reach-k188:' || x.agent_id || ':' || x.person_id, x.org_id, 'agent', x.agent_id,
      'person', x.person_id, COALESCE(a.owner_person_id, x.granted_by), x.revoked_at
    FROM kin_lead_access x
    JOIN kin_people p ON p.org_id = x.org_id AND p.person_id = x.person_id
    JOIN kin_agents a ON a.org_id = x.org_id AND a.agent_id = x.agent_id
    WHERE x.revoked_at IS NOT NULL
      AND p.removed_at IS NOT x.revoked_at
      AND a.owner_person_id IS NOT x.person_id
      -- Owner-level as of this migration: a stored kind, else whoever owns a lead.
      AND COALESCE(p.access, CASE WHEN EXISTS (SELECT 1 FROM kin_leads ol
        JOIN kin_agents o ON o.org_id = ol.org_id AND o.agent_id = ol.agent_id
        WHERE ol.org_id = p.org_id AND o.owner_person_id = p.person_id) THEN 'owner'
        ELSE 'member' END) NOT IN ('owner', 'co_owner')
      AND NOT EXISTS (SELECT 1 FROM kin_team_agents t
        WHERE t.org_id = x.org_id AND t.agent_id = x.agent_id)
    ORDER BY x.org_id, x.agent_id, x.person_id
    ON CONFLICT DO NOTHING`;
});
