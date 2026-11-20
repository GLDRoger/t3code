import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bank alerts by mail (`work/statements/bankAlerts.ts`). A sender is counted only after the
 * owner's or a co-owner's Yes on Kin's card, per mailbox and account. Each alert mail read is one
 * row: a counted bank line beside the statements' own, or kept with why it isn't counted. Alert
 * lines never enter Bank transactions, so no figure built on that list ever counts one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_bank_alert_senders (
      org_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      -- the From address exactly, lowercased: never a display name
      address TEXT NOT NULL,
      -- the account's last four digits the card named
      account TEXT NOT NULL,
      currency TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('asked', 'counted', 'declined', 'stopped')),
      widget_id TEXT NOT NULL,
      asked_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      PRIMARY KEY (org_id, connection_id, address, account)
    )
  `;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_bank_alert_senders_widget
    ON kin_bank_alert_senders (org_id, widget_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_bank_alerts (
      org_id TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      address TEXT NOT NULL,
      -- the mail it came from: its Message-ID, else the vendor's thread and date
      mail_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      -- counted: a bank line; unread and unchecked: kept with why, counted nowhere; replaced and
      -- not_on_statement: a confirmed statement covered its day (statement_id)
      state TEXT NOT NULL CHECK (state IN
        ('counted', 'unread', 'unchecked', 'replaced', 'not_on_statement')),
      reason TEXT,
      account TEXT,
      currency TEXT,
      direction TEXT CHECK (direction IN ('credit', 'debit')),
      amount_minor INTEGER,
      day TEXT,
      party TEXT,
      balance_minor INTEGER,
      reference TEXT,
      -- the one "Did they pay?" card, the invoices it offered (JSON ids) and the answer
      pay_state TEXT CHECK (pay_state IN ('asked', 'paid', 'other', 'unsure', 'asked_again')),
      pay_widget_id TEXT,
      pay_records_json TEXT,
      payment_id TEXT,
      pay_by TEXT,
      pay_at INTEGER,
      statement_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, alert_id)
    )
  `;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_bank_alerts_mail
    ON kin_bank_alerts (org_id, mail_key)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bank_alerts_account
    ON kin_bank_alerts (org_id, account, day)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bank_alerts_pay
    ON kin_bank_alerts (org_id, pay_widget_id)`;
});
