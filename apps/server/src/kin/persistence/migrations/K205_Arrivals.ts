import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each mail a watched mailbox received, noticed once (`arrivals/ArrivalStore.ts`): its sender
 * address, class, reason and provider ids, never its subject or body, kept 30 days. `mail_key`
 * is the same message in another connected mailbox, so it wakes no one twice.
 * `kin_connection_cursors.mail_cursor`: where the vendor's mail change feed stopped.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_arrivals (
    org_id TEXT NOT NULL,
    arrival_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT,
    mail_key TEXT,
    from_address TEXT,
    received_at INTEGER,
    noticed_at INTEGER NOT NULL,
    class TEXT,
    agent_id TEXT,
    event_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('parked', 'new', 'looking', 'settled')),
    outcome TEXT CHECK (outcome IN ('draft', 'task', 'filed', 'nothing')),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
    refs_json TEXT,
    wakeup_id TEXT,
    settled_at INTEGER,
    tries INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER,
    PRIMARY KEY (org_id, arrival_id),
    FOREIGN KEY (org_id, connection_id) REFERENCES kin_connections(org_id, connection_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_arrivals_mail_key
    ON kin_arrivals (org_id, mail_key) WHERE mail_key IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_arrivals_sender
    ON kin_arrivals (org_id, from_address, received_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_arrivals_parked
    ON kin_arrivals (org_id, connection_id, state, retry_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_arrivals_noticed ON kin_arrivals (noticed_at)`;
  const columns = new Set(
    (yield* sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('kin_connection_cursors')`).map((column) => column.name),
  );
  if (!columns.has("mail_cursor"))
    yield* sql`ALTER TABLE kin_connection_cursors ADD COLUMN mail_cursor TEXT`;
});
