import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  if (!columns.some((column) => column.name === "embeds_json"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN embeds_json TEXT NULL`;
  if (!columns.some((column) => column.name === "source_wakeup_id"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN source_wakeup_id TEXT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_message_wakeup_cards
    ON kin_messages (org_id, chat_id, source_wakeup_id) WHERE source_wakeup_id IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_turn_figures (
    org_id TEXT NOT NULL, figure_id TEXT NOT NULL, wakeup_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, kind TEXT NOT NULL,
    embed_json TEXT NOT NULL, client_message_id TEXT, attachment_id TEXT NULL, created_at INTEGER NOT NULL,
    message_id TEXT NULL,
    PRIMARY KEY (org_id, figure_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_turn_figures_wakeup
    ON kin_turn_figures (org_id, wakeup_id)`;
});
