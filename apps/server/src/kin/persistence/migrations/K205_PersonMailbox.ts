import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A person's own mailbox: a connection whose `person_id` names them is theirs alone
 * (`connections/turnMailbox.ts`). NULL is the company's, as every connection made before this is.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [has] = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_connections')
    WHERE name = 'person_id' ORDER BY name`;
  if (has === undefined) yield* sql`ALTER TABLE kin_connections ADD COLUMN person_id TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_connections_person
    ON kin_connections (org_id, person_id) WHERE person_id IS NOT NULL`;
});
