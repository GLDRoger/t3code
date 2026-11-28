import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_chat_pins (
    pin_id TEXT NOT NULL PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    chat_id TEXT NOT NULL REFERENCES kin_chats(chat_id),
    record_id TEXT NOT NULL,
    pinned_by_person_id TEXT NOT NULL,
    pinned_at INTEGER NOT NULL,
    UNIQUE (org_id, chat_id, record_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_chat_pins_source ON kin_chat_pins (org_id, record_id)`;
});
