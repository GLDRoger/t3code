import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per member, message and emoji; withdrawing sets removed_at and re-adding clears it.
  // woke_at marks an owner reaction that woke the lead, for the per-chat cooldown.
  yield* sql`CREATE TABLE kin_reactions (
    org_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    woke_at INTEGER,
    PRIMARY KEY (org_id, chat_id, message_id, member_id, emoji)
  )`;
  yield* sql`CREATE INDEX idx_kin_reactions_woke ON kin_reactions (org_id, chat_id, woke_at)
    WHERE woke_at IS NOT NULL`;
});
