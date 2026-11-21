import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What a new teammate sees once they join, chosen with their invite, and who chose it: the places
 * hold only while that person is still owner-level. Both null keep the usual start.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('kin_people_invites')
    WHERE name IN ('sees_json', 'sees_by_person_id') ORDER BY name`;
  const has = new Set(columns.map((column) => column.name));
  if (!has.has("sees_json")) yield* sql`ALTER TABLE kin_people_invites ADD COLUMN sees_json TEXT`;
  if (!has.has("sees_by_person_id"))
    yield* sql`ALTER TABLE kin_people_invites ADD COLUMN sees_by_person_id TEXT`;
});
