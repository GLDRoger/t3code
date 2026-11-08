import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_routine_preferences (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    routine TEXT NOT NULL CHECK (routine IN ('morning_brief', 'evening_summary', 'owner_check')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    PRIMARY KEY (org_id, routine)
  )`;
  yield* sql`CREATE TABLE kin_routine_folds (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    fire_id TEXT NOT NULL,
    routine TEXT NOT NULL,
    due_at INTEGER NOT NULL CHECK (typeof(due_at) = 'integer'),
    fold_into TEXT NOT NULL CHECK (fold_into IN ('morning_brief', 'evening_summary')),
    PRIMARY KEY (org_id, fire_id)
  )`;
});
