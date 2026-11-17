import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The owner's switch for team memory in shared turns. No row: the host's `KIN_TEAM_MEMORY` holds. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_team_memory (
    org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
    is_on INTEGER NOT NULL CHECK (is_on IN (0, 1)),
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL
  )`;
});
