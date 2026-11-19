import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A question an agent put to someone outside the chat it answered: the chat whose answer it is
 * and the person who asked, if any (`questions/askPerson.ts`), and the card's words while it is
 * held for the person's quiet hours. NULL on every question asked before this.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_questions)`;
  for (const column of ["for_chat_id", "for_person_id", "card_json"])
    if (!columns.some((row) => row.name === column))
      yield* sql`ALTER TABLE kin_questions ADD COLUMN ${sql.literal(column)} TEXT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_questions_for_chat
    ON kin_questions (org_id, for_chat_id) WHERE state = 'open' AND for_chat_id IS NOT NULL`;
});
