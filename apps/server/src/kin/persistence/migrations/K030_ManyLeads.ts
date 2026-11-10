import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Leads that predate domains were the engineering lead, made by the person who owns them.
  yield* sql`ALTER TABLE kin_leads ADD COLUMN domain TEXT NOT NULL DEFAULT 'engineering'
    CHECK (length(domain) BETWEEN 1 AND 40 AND domain NOT GLOB '*[^a-z0-9-]*' AND domain GLOB '[a-z]*')`;
  yield* sql`ALTER TABLE kin_leads ADD COLUMN charter TEXT NOT NULL DEFAULT ''
    CHECK (length(charter) <= 1000)`;
  // The creator is checked to be a person of the lead's org when the lead is created.
  yield* sql`ALTER TABLE kin_leads ADD COLUMN created_by_person_id TEXT`;
  yield* sql`UPDATE kin_leads SET created_by_person_id = (
      SELECT a.owner_person_id FROM kin_agents a
      WHERE a.org_id = kin_leads.org_id AND a.agent_id = kin_leads.agent_id)
    WHERE created_by_person_id IS NULL`;
  yield* sql`CREATE INDEX idx_kin_leads_org_domain ON kin_leads(org_id, domain)`;
});
