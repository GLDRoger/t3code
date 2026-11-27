import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bill_senders (
    org_id TEXT NOT NULL,
    address TEXT NOT NULL,
    name TEXT,
    state TEXT NOT NULL CHECK (state IN ('candidate', 'approved', 'declined', 'removed')),
    seen_count INTEGER NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    decided_by_person_id TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL,
    known_biller INTEGER NOT NULL DEFAULT 0 CHECK (known_biller IN (0, 1)),
    widget_id TEXT,
    card_day TEXT,
    PRIMARY KEY (org_id, address)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bill_senders_waiting
    ON kin_bill_senders (org_id, created_at, address) WHERE state = 'candidate' AND widget_id IS NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bill_senders_card_day
    ON kin_bill_senders (org_id, card_day) WHERE card_day IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bill_sender_mail (
    org_id TEXT NOT NULL,
    mail_key TEXT NOT NULL,
    address TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, mail_key),
    FOREIGN KEY (org_id, address) REFERENCES kin_bill_senders(org_id, address) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bill_sender_mail_address
    ON kin_bill_sender_mail (org_id, address, received_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bill_sender_mail_expiry
    ON kin_bill_sender_mail (received_at)`;
});
