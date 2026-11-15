import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An agent's call to an "Ask me" connection tool, kept as prepared with what its card showed,
 * until the owner's tap sends exactly that or says no. `entry_record_id`: the invoice, quote or
 * receipt whose file it carries, so the entry can show where it was sent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_connection_asks (
    org_id TEXT NOT NULL,
    ask_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    pin_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    widget_id TEXT,
    entry_record_id TEXT,
    state TEXT NOT NULL DEFAULT 'open'
      CHECK (state IN ('open', 'declined', 'stale', 'sending', 'sent', 'failed')),
    reason TEXT,
    result_json TEXT,
    proposed_at INTEGER NOT NULL,
    decided_at INTEGER,
    done_at INTEGER,
    PRIMARY KEY (org_id, ask_id),
    FOREIGN KEY (org_id, connection_id) REFERENCES kin_connections(org_id, connection_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_connection_asks_widgets
    ON kin_connection_asks (org_id, widget_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_connection_asks_entries
    ON kin_connection_asks (org_id, entry_record_id, done_at)`;
});
