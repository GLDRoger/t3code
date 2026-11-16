import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who handed a task back to its holder, and when: shown on its row until it moves on. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_records')`).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("handed_back_kind"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN handed_back_kind TEXT`;
  if (!columns.has("handed_back_id"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN handed_back_id TEXT`;
  if (!columns.has("handed_back_at"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN handed_back_at INTEGER`;
});
