import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Kin writes every memory folder alone now, so no memory PR waits on the owner's review. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS kin_memory_review_pulls`;
});
