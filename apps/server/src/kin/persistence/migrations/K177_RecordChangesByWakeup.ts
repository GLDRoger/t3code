import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A reply's receipt reads its wake-up's changes (`turnChanges`).
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_changes_wakeup
    ON kin_record_changes (org_id, wakeup_id, seq) WHERE wakeup_id IS NOT NULL`;
});
