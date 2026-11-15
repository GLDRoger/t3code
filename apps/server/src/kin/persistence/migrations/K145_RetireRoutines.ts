import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The morning brief, evening summary and Monday owner check retire for every company: the
 * check-ins carry the briefs, so nobody gets two. Their triggers stop and queued fires expire.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_routine_preferences SET enabled = 0`;
  yield* sql`UPDATE kin_triggers SET enabled = 0, next_run_at = NULL
    WHERE trigger_id IN ('routine:morning_brief', 'routine:evening_summary', 'routine:owner_check')`;
  yield* sql`UPDATE kin_events SET state = 'expired' WHERE tag = 'routine' AND state = 'queued'`;
  yield* sql`DELETE FROM kin_routine_folds`;
});
