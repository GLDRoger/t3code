import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const questions = yield* sql<{ name: string }>`PRAGMA table_info(kin_questions)`;
  if (!questions.some((column) => column.name === "message_id"))
    yield* sql`ALTER TABLE kin_questions ADD COLUMN message_id TEXT`;
  const messages = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  if (!messages.some((column) => column.name === "lapsed_question_json"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN lapsed_question_json TEXT`;
});
