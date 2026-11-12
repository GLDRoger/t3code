import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The outside hosts an org's owner lets its visuals load from. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_visual_hosts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    host TEXT NOT NULL,
    added_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, host)
  )`;
});
