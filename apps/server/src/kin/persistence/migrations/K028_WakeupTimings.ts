import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Epoch ms of each reply stage; `started_at` is the claim. NULL means the stage never happened.
  for (const column of ["enqueued_at", "prepared_at", "launched_at", "first_token_at", "posted_at"])
    yield* sql`ALTER TABLE kin_wakeups ADD COLUMN ${sql(column)} INTEGER`;
  yield* sql`ALTER TABLE kin_wakeups ADD COLUMN resumed INTEGER`;
});
