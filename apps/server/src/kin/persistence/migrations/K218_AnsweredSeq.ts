import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * How far a person has answered a chat (a send, a reaction, a card answer), apart from how far
 * they have seen it (`last_read_seq`). Existing rows start where their one mark stood.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_read_state)`;
  if (columns.some((column) => column.name === "answered_seq")) return;
  yield* sql`ALTER TABLE kin_read_state ADD COLUMN answered_seq INTEGER NOT NULL DEFAULT 0
    CHECK (answered_seq >= 0)`;
  yield* sql`UPDATE kin_read_state SET answered_seq = last_read_seq`;
});
