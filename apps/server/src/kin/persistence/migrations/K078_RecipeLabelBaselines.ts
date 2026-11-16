import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Where each documents workspace's `main` was before Kin's first recipe change that labels its
 * revisions as it commits: a revision after it with no label row was left unlabelled by a crash.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_recipe_label_baselines (
    org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
    commit_sha TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )`;
});
