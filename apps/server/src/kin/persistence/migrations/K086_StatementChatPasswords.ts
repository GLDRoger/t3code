import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Wrong passwords a lead passed from the owner's chat messages, counted apart from the card's, so
 * guesses in chat never lock the owner out of typing the right one on the card.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_bank_statements)`;
  if (!columns.some((column) => column.name === "chat_password_attempts"))
    yield* sql`ALTER TABLE kin_bank_statements
      ADD COLUMN chat_password_attempts INTEGER NOT NULL DEFAULT 0`;
});
