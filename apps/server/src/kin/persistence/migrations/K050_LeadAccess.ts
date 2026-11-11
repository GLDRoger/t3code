import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Who besides its owner may message a lead. One row per lead and person: revoking stamps it,
  // allowing them again clears the stamp. No row means only the owner may.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_lead_access (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    agent_id TEXT NOT NULL REFERENCES kin_agents(agent_id),
    person_id TEXT NOT NULL REFERENCES kin_people(person_id),
    granted_by TEXT NOT NULL REFERENCES kin_people(person_id),
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (org_id, agent_id, person_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_lead_access_person
    ON kin_lead_access (org_id, person_id) WHERE revoked_at IS NULL`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_leads)`;
  // What the owner lets other people read about the lead. Never its charter.
  if (!columns.some((column) => column.name === "public_intro"))
    yield* sql`ALTER TABLE kin_leads ADD COLUMN public_intro TEXT NOT NULL DEFAULT ''`;
});
