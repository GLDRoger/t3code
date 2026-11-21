import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A question that carries a teammate's draft up to the owner (`questions/sentUpDraft.ts`): what
 * the draft is, and when the owner's Approve on its card queued his own turn to make it. NULL on
 * every other question.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_questions)`;
  if (!columns.some((row) => row.name === "draft_json"))
    yield* sql`ALTER TABLE kin_questions ADD COLUMN draft_json TEXT NULL`;
  if (!columns.some((row) => row.name === "approved_at"))
    yield* sql`ALTER TABLE kin_questions ADD COLUMN approved_at INTEGER NULL`;
});
