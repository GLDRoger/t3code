import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What Kin's pushes told each person about (`push/KinPushTopics.ts`): one row per person and topic,
 * when the last push about it went and when it was withdrawn, so a settled topic can be taken off
 * their phones. No message text. And whether a phone's build matches notifications by topic.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_push_sent (
    org_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    -- Which push about the topic this person was sent last: 1, 2, ... (KinPushWithdrawn).
    version INTEGER NOT NULL DEFAULT 1,
    -- The chat message the last push came from, when it came from one.
    chat_id TEXT,
    message_id TEXT,
    -- A chat's banner: the newest message position it covers. Read up to it, it is settled.
    seq INTEGER,
    sent_at INTEGER NOT NULL,
    withdrawn_at INTEGER,
    PRIMARY KEY (org_id, person_id, topic)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_push_sent_live
    ON kin_push_sent (org_id, topic) WHERE withdrawn_at IS NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_push_sent_message
    ON kin_push_sent (org_id, message_id) WHERE withdrawn_at IS NULL AND message_id IS NOT NULL`;
  const devices = yield* sql<{ name: string }>`PRAGMA table_info(kin_push_devices)`;
  if (!devices.some((column) => column.name === "withdraws"))
    yield* sql`ALTER TABLE kin_push_devices ADD COLUMN withdraws INTEGER NOT NULL DEFAULT 0
      CHECK (withdraws IN (0, 1))`;
});
