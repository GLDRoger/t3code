import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each person's own quiet hours (null: the company's), whether Kin holds non-urgent lines outside
 * their working hours (null: on for everyone but the owner), and what their access was when it
 * was removed, so a new link brings exactly that back. A held line keeps whose words it passes on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_people')`).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("quiet_hours_json"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN quiet_hours_json TEXT`;
  if (!columns.has("hold_outside_hours"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN hold_outside_hours INTEGER`;
  if (!columns.has("removed_access_json"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN removed_access_json TEXT`;
  const held = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_held_posts')
    WHERE name = 'relay_json'`;
  if (held.length === 0) yield* sql`ALTER TABLE kin_held_posts ADD COLUMN relay_json TEXT`;
});
