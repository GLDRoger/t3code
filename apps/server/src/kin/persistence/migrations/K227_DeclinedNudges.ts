import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_holds)`;
  if (!columns.some(({ name }) => name === "decline_json"))
    yield* sql`ALTER TABLE kin_holds ADD COLUMN decline_json TEXT`;
  yield* sql`DROP INDEX IF EXISTS kin_holds_live`;
  yield* sql`CREATE UNIQUE INDEX kin_holds_live
    ON kin_holds (org_id, record_id, COALESCE(for_person_id, ''))
    WHERE lifted_at IS NULL AND decline_json IS NULL`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_holds_declined_live
    ON kin_holds (org_id, record_id, for_person_id)
    WHERE lifted_at IS NULL AND decline_json IS NOT NULL`;
});
