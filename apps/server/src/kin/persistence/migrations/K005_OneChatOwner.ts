import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE UNIQUE INDEX kin_chat_members_one_owner
    ON kin_chat_members (org_id, chat_id) WHERE role = 'owner' AND left_at IS NULL`;
});
