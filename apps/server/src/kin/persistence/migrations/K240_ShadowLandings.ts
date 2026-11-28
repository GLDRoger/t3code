import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per lead whose L0 shadow notes `MemoryWriter.landShadows` has tried to land. It is
// written before the push, so a retry checks for that exact commit instead of guessing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_shadow_landings (
    org_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    commit_id TEXT,
    held_json TEXT NOT NULL,
    landed_at INTEGER,
    PRIMARY KEY (org_id, agent_id)
  )`;
});
