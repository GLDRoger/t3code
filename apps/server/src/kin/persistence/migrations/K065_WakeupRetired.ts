import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When retiring aborted a running wake-up. A restore leaves it set, so work that turn sent while
 * it was retired still starts stopped; a join's abort leaves it null.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_wakeups)`;
  if (!columns.some((column) => column.name === "retired_at"))
    yield* sql`ALTER TABLE kin_wakeups ADD COLUMN retired_at INTEGER
      CHECK (retired_at IS NULL OR typeof(retired_at) = 'integer')`;
});
