import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Marks the projects Kin made for itself before it marked them at creation: a lead's project is
 * `kin:<org>:<agent>` for a lead in `kin_leads`, a dream project `kin-dream:<org>[:<dream>]` for a
 * dream in `kin_dream_runs`. The creating event is marked too, so a projection rebuild keeps it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Kin's tables can migrate before upstream's; with no column there is nothing to mark yet.
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_projects')
    WHERE name = 'internal'`;
  if (columns.length === 0) return;
  const proven = sql`
    SELECT 'kin:' || org_id || ':' || agent_id FROM kin_leads
    UNION SELECT 'kin-dream:' || org_id FROM kin_dream_runs
    UNION SELECT 'kin-dream:' || org_id || ':' || dream_id FROM kin_dream_runs`;
  yield* sql`UPDATE projection_projects SET internal = 1 WHERE project_id IN (${proven})`;
  yield* sql`UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.internal', json('true'))
    WHERE aggregate_kind = 'project' AND event_type = 'project.created'
      AND json_valid(payload_json) AND stream_id IN (${proven})`;
});
