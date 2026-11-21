import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * How Kin's reads of each mail account stand: the last read that worked, and since when and why
 * reading has failed, so an account that stops syncing shows on its own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_connections')`).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("read_ok_at"))
    yield* sql`ALTER TABLE kin_connections ADD COLUMN read_ok_at INTEGER`;
  if (!columns.has("read_failed_at"))
    yield* sql`ALTER TABLE kin_connections ADD COLUMN read_failed_at INTEGER`;
  if (!columns.has("read_error"))
    yield* sql`ALTER TABLE kin_connections ADD COLUMN read_error TEXT`;
});
