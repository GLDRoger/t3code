import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_handoffs)`;
  if (!columns.some((column) => column.name === "wants_answer"))
    yield* sql`ALTER TABLE kin_handoffs ADD COLUMN wants_answer INTEGER NULL
      CHECK (wants_answer IN (0, 1))`;
});
