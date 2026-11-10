import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The wake-up that consumed a grant; its later replies in the same floor run reuse it.
  yield* sql`ALTER TABLE kin_floor_grants ADD COLUMN consumed_wakeup_id TEXT`;
});
