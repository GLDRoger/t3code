import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The push each approver key change owes its owner, recorded in the change's transaction and
 * settled once sent, so one lost to a restart goes out at the next start.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_key_pushes (
    org_id TEXT NOT NULL,
    thumbprint TEXT NOT NULL,
    change TEXT NOT NULL CHECK (change IN ('added', 'removed')),
    -- The notice's server-written text, as the owner's chat shows it.
    body TEXT NOT NULL,
    -- That chat notice, whose own push this one replaces; NULL when no chat only the owner reads.
    message_id TEXT,
    owed_at INTEGER NOT NULL,
    sent_at INTEGER,
    PRIMARY KEY (org_id, thumbprint, change)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_key_pushes_message
    ON kin_key_pushes (org_id, message_id) WHERE message_id IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_key_pushes_owed
    ON kin_key_pushes (owed_at) WHERE sent_at IS NULL`;
});
