import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether Kin's GitHub App can change each watched repo's default branch, as the last repo refresh
 * read it, and the id of the ruleset Kin made there, the only protection Kin ever removes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_github_branch_guards (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    state TEXT NOT NULL,
    problem TEXT,
    by_kin INTEGER NOT NULL DEFAULT 0,
    kin_ruleset_id INTEGER,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, repo)
  )`;
});
