import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Once a day each: the warning at 80% of the owner's limit, and the teammates' limit notice. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_budget)`;
  if (!columns.some((column) => column.name === "warned_at"))
    yield* sql`ALTER TABLE kin_budget ADD COLUMN warned_at INTEGER`;
  if (!columns.some((column) => column.name === "teammates_notified_at"))
    yield* sql`ALTER TABLE kin_budget ADD COLUMN teammates_notified_at INTEGER`;
});
