import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_company_shell (
    org_id TEXT PRIMARY KEY REFERENCES kin_orgs(org_id),
    shell_json TEXT NOT NULL,
    rev INTEGER NOT NULL,
    set_by TEXT,
    set_at INTEGER NOT NULL
  )`;
});
