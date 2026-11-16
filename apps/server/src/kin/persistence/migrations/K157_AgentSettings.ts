import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** An agent the owner paused, and the models new agents start on. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_agents') WHERE name = 'paused_at'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_agents ADD COLUMN paused_at TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_agent_defaults (
    org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
    models_json TEXT NOT NULL
  )`;
});
