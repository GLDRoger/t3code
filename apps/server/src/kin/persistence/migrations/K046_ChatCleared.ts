import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A cleared chat's rows are deleted, so no changed row tells a returning client they are gone.
 * The chat's `change_seq` at its last clear does: a cursor below it is from before the clear.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_chats ADD COLUMN cleared_change_seq INTEGER NOT NULL DEFAULT 0`;
});
