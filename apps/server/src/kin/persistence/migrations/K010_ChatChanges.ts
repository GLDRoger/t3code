import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_chats ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE kin_messages ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0`;
  // Old clients may have missed edits before this migration; replay existing rows once.
  yield* sql`UPDATE kin_chats SET change_seq = last_seq + 1`;
  yield* sql`UPDATE kin_messages SET change_seq = (SELECT change_seq FROM kin_chats WHERE kin_chats.org_id = kin_messages.org_id AND kin_chats.chat_id = kin_messages.chat_id)`;
  yield* sql`CREATE INDEX idx_kin_messages_changes ON kin_messages(org_id, chat_id, change_seq, seq)`;
  yield* sql`CREATE TRIGGER kin_message_insert_change AFTER INSERT ON kin_messages BEGIN
    UPDATE kin_chats SET change_seq = change_seq + 1 WHERE org_id = NEW.org_id AND chat_id = NEW.chat_id;
    UPDATE kin_messages SET change_seq = (SELECT change_seq FROM kin_chats WHERE org_id = NEW.org_id AND chat_id = NEW.chat_id)
      WHERE org_id = NEW.org_id AND message_id = NEW.message_id;
  END`;
  // The internal watermark update must not recursively allocate another change.
  yield* sql`CREATE TRIGGER kin_message_update_change AFTER UPDATE ON kin_messages
    WHEN NEW.change_seq = OLD.change_seq BEGIN
    UPDATE kin_chats SET change_seq = change_seq + 1 WHERE org_id = NEW.org_id AND chat_id = NEW.chat_id;
    UPDATE kin_messages SET change_seq = (SELECT change_seq FROM kin_chats WHERE org_id = NEW.org_id AND chat_id = NEW.chat_id)
      WHERE org_id = NEW.org_id AND message_id = NEW.message_id;
  END`;
  for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
    const row = event === "DELETE" ? "OLD" : "NEW";
    yield* sql.unsafe(`CREATE TRIGGER kin_widget_${event.toLowerCase()}_change AFTER ${event} ON kin_widgets BEGIN
      UPDATE kin_chats SET change_seq = change_seq + 1 WHERE org_id = ${row}.org_id AND chat_id = ${row}.chat_id;
      UPDATE kin_messages SET change_seq = (SELECT change_seq FROM kin_chats WHERE org_id = ${row}.org_id AND chat_id = ${row}.chat_id)
        WHERE org_id = ${row}.org_id AND message_id = ${row}.message_id;
    END`);
  }
});
