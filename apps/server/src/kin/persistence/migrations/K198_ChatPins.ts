import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** When a person pinned a chat to the top of their own list, in epoch ms; null when not pinned. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('kin_chat_members') WHERE name = 'pinned_at'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_chat_members ADD COLUMN pinned_at INTEGER`;
});
