import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_wakeups)`;
  if (!columns.some((column) => column.name === "quiet_since"))
    yield* sql`ALTER TABLE kin_wakeups ADD COLUMN quiet_since INTEGER`;
});
