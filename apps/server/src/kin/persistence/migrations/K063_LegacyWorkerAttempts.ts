import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A worker still open from before K061 has no attempt row, or one made lazily that names no event.
 * Either way it ends up with a row marked `legacy`. Nothing is stopped or ended.
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
  // A row made lazily before this column existed names no event either: it is legacy too.
  yield* sql`UPDATE kin_worker_attempts SET legacy = 1 WHERE source_event_id IS NULL`;
});
