import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  if (!columns.some((column) => column.name === "attachments_json"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN attachments_json TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_message_attachments (
    attachment_id TEXT PRIMARY KEY NOT NULL,
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL
  )`;
});
