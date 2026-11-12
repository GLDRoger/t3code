import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Retiring an agent marks every one of its wake-ups not yet marked, not only running ones. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_wakeups_unretired_agent
    ON kin_wakeups(org_id, agent_id) WHERE retired_at IS NULL`;
});
