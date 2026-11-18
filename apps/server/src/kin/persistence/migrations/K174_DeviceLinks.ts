import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A link a person made for one more of their own devices: its typed code (hashed), and who made
 * it, so such a link never brings back someone the owner removed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('kin_people_invites')`;
  const has = new Set(columns.map((column) => column.name));
  if (!has.has("code_hash")) yield* sql`ALTER TABLE kin_people_invites ADD COLUMN code_hash TEXT`;
  if (!has.has("made_by_person_id"))
    yield* sql`ALTER TABLE kin_people_invites ADD COLUMN made_by_person_id TEXT`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_people_invites_code
    ON kin_people_invites (code_hash) WHERE code_hash IS NOT NULL`;
});
