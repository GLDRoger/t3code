import { KIN_YES_REACTIONS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The owner's reactions that woke the lead, one row per message: the emoji and answer the last
  // wake carried (a withdrawn yes has none), how many there were, and when, for the cooldown.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_reaction_wakes (
    org_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    answer TEXT CHECK (answer IN ('yes', 'no')),
    wakes INTEGER NOT NULL,
    woke_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, message_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_reaction_wakes_chat
    ON kin_reaction_wakes (org_id, chat_id, woke_at)`;
  // Bare columns follow the MAX row: each message's latest waking reaction.
  yield* sql`INSERT INTO kin_reaction_wakes (org_id, chat_id, message_id, emoji, answer, wakes, woke_at)
    SELECT org_id, chat_id, message_id, emoji,
      CASE WHEN emoji IN ${sql.in(KIN_YES_REACTIONS)} THEN 'yes' ELSE 'no' END, 1, MAX(woke_at)
    FROM kin_reactions WHERE woke_at IS NOT NULL
    GROUP BY org_id, chat_id, message_id
    ON CONFLICT (org_id, message_id) DO NOTHING`;
});
