import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Where a mail vendor's calendar change feed stopped, for one that keeps one (Microsoft Graph). */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('kin_connection_cursors')`).map((column) => column.name),
  );
  if (!columns.has("calendar_cursor"))
    yield* sql`ALTER TABLE kin_connection_cursors ADD COLUMN calendar_cursor TEXT`;
});
