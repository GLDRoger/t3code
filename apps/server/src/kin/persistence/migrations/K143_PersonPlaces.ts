import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The places a member sees beyond Tasks (`work/teamView.ts` `personSees`). Everyone already here
 * keeps Tasks alone; new invites start with Clients and Docs on (`KinPeople.accept`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(kin_people)`).map((column) => column.name),
  );
  for (const column of ["sees_clients", "sees_docs", "sees_money"])
    if (!columns.has(column))
      yield* sql`ALTER TABLE kin_people ADD COLUMN ${sql.literal(column)} INTEGER NOT NULL DEFAULT 0
        CHECK (${sql.literal(column)} IN (0, 1))`;
});
