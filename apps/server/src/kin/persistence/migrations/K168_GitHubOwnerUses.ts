import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Each command an agent ran as the owner's own GitHub login (`kin-as-owner`), secrets taken out. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_github_owner_uses (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    use_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    agent_name TEXT,
    repo TEXT,
    command TEXT NOT NULL,
    PRIMARY KEY (org_id, use_id)
  )`;
});
