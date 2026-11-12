import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The owner's changes to the hosts a worker's shell may reach: an allowed host, or a removed one. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_worker_network (
    org_id TEXT NOT NULL,
    host TEXT NOT NULL,
    allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    changed_at INTEGER NOT NULL,
    changed_by TEXT NOT NULL,
    PRIMARY KEY (org_id, host)
  )`;
});
