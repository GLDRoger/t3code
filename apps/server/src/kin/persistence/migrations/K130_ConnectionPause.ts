import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** When the owner paused a connection: agents can't reach it until resumed. NULL is running. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(kin_connections)`).map((column) => column.name),
  );
  if (!columns.has("paused_at"))
    yield* sql`ALTER TABLE kin_connections ADD COLUMN paused_at INTEGER`;
});
