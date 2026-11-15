import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Once a day each: the warning at 80% of the owner's limit, and the teammates' limit notice.
 * Each charge says whether a teammate asked for its turn, so their spending never counts as the
 * owner's.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_budget)`;
  if (!columns.some((column) => column.name === "warned_at"))
    yield* sql`ALTER TABLE kin_budget ADD COLUMN warned_at INTEGER`;
  if (!columns.some((column) => column.name === "teammates_notified_at"))
    yield* sql`ALTER TABLE kin_budget ADD COLUMN teammates_notified_at INTEGER`;
  const charges = yield* sql<{ name: string }>`PRAGMA table_info(kin_budget_charges)`;
  if (!charges.some((column) => column.name === "teammate")) {
    yield* sql`ALTER TABLE kin_budget_charges ADD COLUMN teammate INTEGER NOT NULL DEFAULT 0
      CHECK (teammate IN (0, 1))`;
    yield* sql`UPDATE kin_budget_charges SET teammate = 1
      WHERE EXISTS (SELECT 1 FROM kin_events e
        JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
        WHERE e.org_id = kin_budget_charges.org_id AND e.wakeup_id = kin_budget_charges.wakeup_id
          AND (json_extract(e.json, '$.origin.personId') IS NOT NULL
            OR (json_extract(e.json, '$.provenance._tag') = 'human'
              AND json_extract(e.json, '$.provenance.personId') <> a.owner_person_id)))`;
  }
});
