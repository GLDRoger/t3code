import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_workers ADD COLUMN title TEXT`;
  yield* sql`ALTER TABLE kin_workers ADD COLUMN chat_id TEXT`;
  yield* sql`CREATE TABLE kin_worker_charges (
    org_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    day TEXT NOT NULL,
    units REAL NOT NULL CHECK (units >= 0),
    tokens_json TEXT NOT NULL,
    PRIMARY KEY (org_id, run_id),
    FOREIGN KEY (org_id, worker_id) REFERENCES kin_workers(org_id, worker_id),
    FOREIGN KEY (org_id, day) REFERENCES kin_budget(org_id, day)
  )`;
});
