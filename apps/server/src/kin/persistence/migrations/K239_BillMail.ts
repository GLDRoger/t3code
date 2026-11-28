import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bill_mail (
    org_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT,
    address TEXT NOT NULL,
    received_at INTEGER,
    mail_key TEXT,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'reading', 'done', 'skipped')),
    reason TEXT,
    tries INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    asked_by_person_id TEXT,
    batch_id TEXT,
    queued_at INTEGER NOT NULL,
    done_at INTEGER,
    PRIMARY KEY (org_id, connection_id, message_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_bill_mail_key
    ON kin_bill_mail (org_id, mail_key) WHERE mail_key IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bill_mail_due
    ON kin_bill_mail (org_id, state, next_at)`;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_bill_reads')`).map(
      ({ name }) => name,
    ),
  );
  if (!columns.has("mail_from")) yield* sql`ALTER TABLE kin_bill_reads ADD COLUMN mail_from TEXT`;
  if (!columns.has("mail_at")) yield* sql`ALTER TABLE kin_bill_reads ADD COLUMN mail_at INTEGER`;
});
