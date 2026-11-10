import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_wakeups)`;
  // Who the wake-up's prompt was built for (lead/Audience.ts); null predates the record.
  if (!columns.some((column) => column.name === "audience"))
    yield* sql`ALTER TABLE kin_wakeups ADD COLUMN audience TEXT
      CHECK (audience IS NULL OR audience IN ('owner_only', 'shared'))`;
});
