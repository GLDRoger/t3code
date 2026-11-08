import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // TRIG-7 writes armed/disarmed; the due flow (TRIG-8) owns the remaining states.
  yield* sql`CREATE TABLE kin_deferral_runs (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    item_id TEXT NOT NULL,
    state TEXT NOT NULL,
    due_at INTEGER CHECK (due_at IS NULL OR typeof(due_at) = 'integer'),
    on_due TEXT NOT NULL CHECK (on_due IN ('remind', 'start', 'ask', 'chase')),
    snapshot_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
    PRIMARY KEY (org_id, item_id)
  )`;
});
