import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Entries the owner shared with the team. Every entry that exists when this lands stays the
 * owner's alone until he shares it; teammates see only those and their own (`teamView.ts`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_records)`;
  if (!columns.some((column) => column.name === "team_shared"))
    yield* sql`ALTER TABLE kin_records
      ADD COLUMN team_shared INTEGER NOT NULL DEFAULT 0 CHECK (team_shared IN (0, 1))`;
});
