import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_messages_conversation
    ON kin_messages (org_id, chat_id, author_person_id, created_at)
    WHERE author_kind = 'human' AND kind = 'text' AND status = 'posted'`;
});
