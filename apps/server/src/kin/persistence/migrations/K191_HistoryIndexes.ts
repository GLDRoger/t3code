import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What an agent posted in one wake-up, which its finish and its reply checks read, and an org's
 * wake-ups by when they started, which the briefs count: both read a year of history without them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_messages_agent_thread
    ON kin_messages (org_id, author_agent_id, author_thread_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_wakeups_started
    ON kin_wakeups (org_id, started_at)`;
});
