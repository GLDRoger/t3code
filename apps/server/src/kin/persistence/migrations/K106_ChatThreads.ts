import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The chat a lead thread answers in: a turn anyone besides the owner reads runs on its chat's own
 * thread, so no model context crosses chats. NULL is the owner's thread, or one from before this.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(kin_agent_threads)`).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("chat_id")) yield* sql`ALTER TABLE kin_agent_threads ADD COLUMN chat_id TEXT`;
});
