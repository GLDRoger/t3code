import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bank_senders (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    address TEXT NOT NULL CHECK (address = lower(address)),
    bank_key TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    accounts_json TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (state IN ('candidate', 'approved', 'declined', 'removed')),
    seen_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    seen_accounts_json TEXT NOT NULL DEFAULT '[]',
    matched_from TEXT CHECK (matched_from IN ('company_details', 'statement', 'settings', 'carried')),
    decided_by_person_id TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, address)
  )`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_bank_alerts)`;
  if (columns.some(({ name }) => name === "sender_address")) return;
  yield* sql`WITH known AS (
      SELECT org_id, account, MIN(seen_at) AS seen_at FROM kin_bank_alerts
      WHERE bank = 'HDFC Bank' AND outcome IN ('recorded', 'duplicate')
        AND account GLOB '[0-9][0-9][0-9][0-9]'
      GROUP BY org_id, account ORDER BY org_id, account
    ), addresses(address) AS (VALUES ('alerts@hdfcbank.net'), ('alerts@hdfcbank.bank.in'))
    INSERT INTO kin_bank_senders
      (org_id, address, bank_key, bank_name, accounts_json, state, matched_from, created_at)
    SELECT org_id, address, 'hdfc', 'HDFC Bank', json_group_array(account), 'approved',
      'carried', MIN(seen_at)
    FROM known CROSS JOIN addresses GROUP BY org_id, address ON CONFLICT DO NOTHING`;

  // SQLite can't widen an existing CHECK in place.
  yield* sql`ALTER TABLE kin_bank_alerts RENAME TO kin_bank_alerts_before_senders`;
  yield* sql`CREATE TABLE kin_bank_alerts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    alert_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    sent_at INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('recorded', 'duplicate', 'sender', 'unverified',
      'unparsed', 'held', 'other_account')),
    bank TEXT,
    account TEXT,
    reference TEXT,
    record_id TEXT,
    currency TEXT,
    balance_minor INTEGER,
    seen_at INTEGER NOT NULL,
    sender_address TEXT,
    PRIMARY KEY (org_id, alert_id)
  )`;
  yield* sql`INSERT INTO kin_bank_alerts (org_id, alert_id, connection_id, thread_id, sent_at,
    outcome, bank, account, reference, record_id, currency, balance_minor, seen_at)
    SELECT org_id, alert_id, connection_id, thread_id, sent_at, outcome, bank, account, reference,
      record_id, currency, balance_minor, seen_at FROM kin_bank_alerts_before_senders`;
  yield* sql`DROP TABLE kin_bank_alerts_before_senders`;
  yield* sql`CREATE INDEX kin_bank_alerts_thread
    ON kin_bank_alerts (org_id, connection_id, thread_id)`;
  yield* sql`CREATE INDEX kin_bank_alerts_balance
    ON kin_bank_alerts (org_id, bank, account, sent_at) WHERE balance_minor IS NOT NULL`;
  yield* sql`CREATE INDEX kin_bank_alerts_record
    ON kin_bank_alerts (org_id, record_id) WHERE record_id IS NOT NULL`;
  yield* sql`CREATE INDEX kin_bank_alerts_sender
    ON kin_bank_alerts (org_id, sender_address, sent_at) WHERE sender_address IS NOT NULL`;
});
