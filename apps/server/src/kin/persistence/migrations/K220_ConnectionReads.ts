import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * How Kin's reads of each mail account stand: the last read that worked, since when and why
 * reading has failed, and since when Kin watches it (`watched_at`), so an account that stops
 * syncing shows on its own.
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
  if (!columns.has("watched_at")) {
    yield* sql`ALTER TABLE kin_connections ADD COLUMN watched_at INTEGER`;
    // Kin was already reading these but kept no record: their quiet day counts from now, and
    // the last read that worked stays unknown until one does.
    yield* sql`UPDATE kin_connections SET watched_at = ${yield* Clock.currentTimeMillis}
      WHERE kind = 'builtin' AND preset IN ('google', 'microsoft') AND removed_at IS NULL
        AND person_id IS NULL`;
  }
});
