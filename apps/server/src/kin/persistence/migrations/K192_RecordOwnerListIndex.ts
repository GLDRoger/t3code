import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** What a person holds of one list, as "projects they lead" asks for every entry a teammate reads. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_owner_list
    ON kin_records (org_id, owner_kind, owner_id, register_id)`;
});
