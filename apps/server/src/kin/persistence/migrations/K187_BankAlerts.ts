import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bank alerts by mail (`work/statements/bankAlerts.ts`): approvals (mailbox, sender, account,
 * currency), counted only after a Yes on Kin's card, and one row per alert mail read. Alert lines
 * never enter Bank transactions, so no figure built on that list ever counts one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_bank_alert_senders (
      org_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      -- the From address exactly, lowercased: never a display name
      address TEXT NOT NULL,
      -- the account's last four digits and its currency, as the card named them
      account TEXT NOT NULL,
      currency TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('asked', 'counted', 'declined', 'stopped')),
      widget_id TEXT NOT NULL,
      -- the confirmed statements' accounts the card offered, by bank (JSON), when several fit
      choices_json TEXT,
      -- open: no statement account yet; bound: to the account of that bank (folded, '' for none
      -- printed) with these digits and currency; none: the owner said it is none of them
      bound TEXT NOT NULL DEFAULT 'open' CHECK (bound IN ('open', 'bound', 'none')),
      bound_bank TEXT,
      asked_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      -- alerts count from this time on; the sender's own read of its mail resumes from cursor_at
      since_at INTEGER,
      cursor_at INTEGER,
      CHECK ((bound = 'bound') = (bound_bank IS NOT NULL)),
      CHECK (state NOT IN ('counted', 'stopped') OR (since_at IS NOT NULL AND cursor_at IS NOT NULL)),
      PRIMARY KEY (org_id, sender_id),
      UNIQUE (org_id, connection_id, address, account, currency)
    )
  `;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_bank_alert_senders_widget
    ON kin_bank_alert_senders (org_id, widget_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_bank_alerts (
      org_id TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      -- the mail it came from: the vendor's own id of the message in that mailbox
      message_id TEXT NOT NULL,
      address TEXT NOT NULL,
      -- the approval it belongs to; null only while no approval names its account
      sender_id TEXT,
      subject TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      -- unread: waits for a reader, its cut text kept until then; counted: a bank line;
      -- not_counted: kept with why; replaced and not_on_statement: a confirmed statement
      -- covered its day (statement_id, and statement_line for the line that replaced it)
      state TEXT NOT NULL CHECK (state IN
        ('unread', 'counted', 'not_counted', 'replaced', 'not_on_statement')),
      reason TEXT,
      text TEXT,
      account TEXT,
      currency TEXT,
      direction TEXT CHECK (direction IN ('credit', 'debit')),
      amount_minor INTEGER,
      day TEXT,
      party TEXT,
      balance_minor INTEGER,
      reference TEXT,
      -- the one "Did they pay?" card, what it offered (JSON: invoice, client and balance) and the answer
      pay_state TEXT CHECK (pay_state IN ('asked', 'paid', 'other', 'unsure', 'closed')),
      pay_widget_id TEXT,
      pay_records_json TEXT,
      pay_redrawn INTEGER NOT NULL DEFAULT 0,
      payment_id TEXT,
      pay_by TEXT,
      pay_at INTEGER,
      statement_id TEXT,
      statement_line INTEGER,
      created_at INTEGER NOT NULL,
      CHECK (state NOT IN ('counted', 'replaced', 'not_on_statement') OR (sender_id IS NOT NULL
        AND account IS NOT NULL AND currency IS NOT NULL AND direction IS NOT NULL
        AND amount_minor > 0 AND day IS NOT NULL)),
      CHECK ((state = 'unread') = (text IS NOT NULL)),
      CHECK (state <> 'not_counted' OR reason IS NOT NULL),
      CHECK (state NOT IN ('replaced', 'not_on_statement') OR statement_id IS NOT NULL),
      CHECK (pay_state IS NULL OR pay_widget_id IS NOT NULL),
      PRIMARY KEY (org_id, alert_id),
      UNIQUE (org_id, connection_id, message_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bank_alerts_sender
    ON kin_bank_alerts (org_id, sender_id, day)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bank_alerts_state
    ON kin_bank_alerts (org_id, state, received_at)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_bank_alerts_pay
    ON kin_bank_alerts (org_id, pay_widget_id) WHERE pay_widget_id IS NOT NULL`;
});
