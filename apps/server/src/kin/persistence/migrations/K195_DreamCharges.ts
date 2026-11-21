import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** What each nightly dream turn spent, keyed by its thread: it counts against the agents' limit. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_dream_charges (
    org_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    day TEXT NOT NULL,
    units REAL NOT NULL CHECK (units >= 0),
    tokens_json TEXT NOT NULL,
    PRIMARY KEY (org_id, thread_id),
    FOREIGN KEY (org_id, day) REFERENCES kin_budget(org_id, day)
  )`;
});
