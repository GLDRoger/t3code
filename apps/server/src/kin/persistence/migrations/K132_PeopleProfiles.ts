import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who each person is, in their own words: picture, role tags, skills, hours. Agents gain role
 * tags too. `kin_team_agents` holds the agent every teammate may message; no row is off.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (table: string) =>
    sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );
  const people = yield* columns("kin_people");
  if (!people.has("avatar_attachment_id"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN avatar_attachment_id TEXT`;
  if (!people.has("role_tags_json"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN role_tags_json TEXT NOT NULL DEFAULT '[]'`;
  if (!people.has("skills"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN skills TEXT NOT NULL DEFAULT ''`;
  if (!people.has("time_zone")) yield* sql`ALTER TABLE kin_people ADD COLUMN time_zone TEXT`;
  if (!people.has("work_hours_json"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN work_hours_json TEXT`;
  if (!people.has("profile_updated_at"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN profile_updated_at INTEGER`;
  if (!(yield* columns("kin_leads")).has("role_tags_json"))
    yield* sql`ALTER TABLE kin_leads ADD COLUMN role_tags_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_team_agents (
    org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
    agent_id TEXT NOT NULL,
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    FOREIGN KEY (org_id, agent_id) REFERENCES kin_agents(org_id, agent_id),
    FOREIGN KEY (org_id, set_by) REFERENCES kin_people(org_id, person_id)
  )`;
});
