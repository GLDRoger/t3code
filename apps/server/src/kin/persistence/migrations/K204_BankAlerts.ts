import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each bank alert mail Kin looked at, once: what came of it, never its text. A recorded or
 * duplicate alert names its account's last four digits, its reference, the bank transaction it
 * is, and the "Avl bal" it printed with the instant it was sent, which is Kin's newest balance
 * of that account when no statement is newer. A rejected one keeps only its reason, to be counted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bank_alerts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    alert_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    sent_at INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('recorded', 'duplicate', 'sender', 'unverified',
      'unparsed')),
    bank TEXT,
    account TEXT,
    reference TEXT,
    record_id TEXT,
    currency TEXT,
    balance_minor INTEGER,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, alert_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bank_alerts_thread
    ON kin_bank_alerts (org_id, connection_id, thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bank_alerts_balance
    ON kin_bank_alerts (org_id, bank, account, sent_at) WHERE balance_minor IS NOT NULL`;
});
