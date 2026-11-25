import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A task's steps, as one JSON list of checklist lines (title, done) in order, and its urgent mark.
 * A step is never a row of its own, so no list, count or agent query can meet one. NULL on every
 * task made before this: no steps, not urgent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_records')
    WHERE name IN ('steps_json', 'urgent') ORDER BY name`;
  const has = new Set(columns.map((column) => column.name));
  if (!has.has("steps_json")) yield* sql`ALTER TABLE kin_records ADD COLUMN steps_json TEXT`;
  if (!has.has("urgent"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN urgent INTEGER CHECK (urgent IN (0, 1))`;
});
