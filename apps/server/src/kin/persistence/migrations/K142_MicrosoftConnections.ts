import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Microsoft accounts are connections too, so the preset CHECK widens. SQLite can't alter a
 * CHECK, so the table is rebuilt from its own stored definition. Four tables reference it:
 * with their checks deferred, the copied rows satisfy them again before the commit, and a lost
 * row fails the commit instead of orphaning anything.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [table] = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'kin_connections'`;
  const before = "'zoho_books')";
  if (table === undefined || !table.sql.includes(before)) return;
  const indexes = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND tbl_name = 'kin_connections' AND sql IS NOT NULL ORDER BY name`;
  yield* Effect.gen(function* () {
    yield* sql`PRAGMA defer_foreign_keys = ON`;
    yield* sql`CREATE TABLE kin_connections_k142 AS SELECT * FROM kin_connections`;
    yield* sql`DROP TABLE kin_connections`;
    yield* sql.unsafe(table.sql.replace(before, "'zoho_books', 'microsoft')"));
    for (const index of indexes) yield* sql.unsafe(index.sql);
    yield* sql`INSERT INTO kin_connections SELECT * FROM kin_connections_k142`;
    yield* sql`DROP TABLE kin_connections_k142`;
  }).pipe(sql.withTransaction);
});
