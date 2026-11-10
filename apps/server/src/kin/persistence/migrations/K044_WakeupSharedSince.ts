import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_wakeups)`;
  // When an owner-only turn was first found readable by someone else; it stays shared after.
  if (!columns.some((column) => column.name === "shared_since"))
    yield* sql`ALTER TABLE kin_wakeups ADD COLUMN shared_since INTEGER`;
});
