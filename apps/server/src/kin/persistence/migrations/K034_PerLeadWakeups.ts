import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One running wake-up per lead, not per organization; existing rows satisfy the narrower index.
  yield* sql`CREATE UNIQUE INDEX idx_kin_wakeups_running_lead
    ON kin_wakeups(org_id, agent_id) WHERE status = 'running'`;
  yield* sql`DROP INDEX idx_kin_wakeups_running_org`;
});
