import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A worker still open from before K061 has no attempt row. It gets one now, marked `legacy` and
 * naming no event, so no later code meets a worker without a row. Nothing is stopped or ended.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_worker_attempts)`;
  if (!columns.some((column) => column.name === "legacy"))
    yield* sql`ALTER TABLE kin_worker_attempts ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0
      CHECK (legacy IN (0, 1))`;
  yield* sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id, legacy)
    SELECT org_id, worker_id, started_at, agent_id, 1 FROM kin_workers WHERE ended_at IS NULL
    ON CONFLICT (org_id, worker_id, started_at) DO NOTHING`;
});
