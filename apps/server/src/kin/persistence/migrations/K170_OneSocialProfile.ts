import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One live group per social profile. Two saves that overlapped could have connected one profile
 * twice; the earliest keeps it, and a later one is disconnected as if removed in Kin.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const later = `SELECT g.org_id, g.group_id FROM kin_social_groups g
    WHERE g.removed_at IS NULL AND EXISTS (SELECT 1 FROM kin_social_groups e
      WHERE e.org_id = g.org_id AND e.service = g.service AND e.profile_id = g.profile_id
        AND e.removed_at IS NULL AND (e.created_at, e.group_id) < (g.created_at, g.group_id))`;
  yield* sql.unsafe(`UPDATE kin_social_posts SET state = 'removed'
    WHERE state IN ('draft', 'proposed') AND (org_id, group_id) IN (${later})`);
  yield* sql.unsafe(`UPDATE kin_social_groups SET removed_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE (org_id, group_id) IN (${later})`);
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_kin_social_groups_profile
    ON kin_social_groups(org_id, service, profile_id) WHERE removed_at IS NULL`;
});
