import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_budget_charges (
    org_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    day TEXT NOT NULL,
    units REAL NOT NULL CHECK (units >= 0),
    tokens_json TEXT NOT NULL,
    PRIMARY KEY (org_id, wakeup_id),
    FOREIGN KEY (org_id, wakeup_id) REFERENCES kin_wakeups(org_id, wakeup_id),
    FOREIGN KEY (org_id, day) REFERENCES kin_budget(org_id, day)
  )`;
  yield* sql`ALTER TABLE kin_events ADD COLUMN budget_deferred INTEGER NOT NULL DEFAULT 0 CHECK (budget_deferred IN (0, 1))`;
});
