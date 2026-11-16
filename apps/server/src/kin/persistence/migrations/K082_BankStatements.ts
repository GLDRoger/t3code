import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bank and card statements sent in chat: what Kin read from each file and the review it proposed,
 * each entry an owner's confirm applied (so the statement can be undone as one), and which
 * accounts' statement passwords the owner asked Kin to keep. No password is ever stored here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bank_statements (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    statement_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('needs_password', 'read', 'scanned', 'unreadable')),
    reason TEXT,
    source TEXT NOT NULL DEFAULT 'file' CHECK (source IN ('file', 'agent')),
    account TEXT,
    review_json TEXT,
    review_hash TEXT,
    review_widget_id TEXT,
    password_widget_id TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    applied_at INTEGER,
    applied_by TEXT,
    undone_at INTEGER,
    PRIMARY KEY (org_id, statement_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_bank_statements_widgets
    ON kin_bank_statements (org_id, review_widget_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_bank_statement_entries (
    org_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    row_index INTEGER NOT NULL,
    bank_record_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('row', 'payment', 'tds', 'expense_paid',
      'expense_linked', 'expense_new', 'transfer', 'ignore')),
    target_record_id TEXT,
    payment_id TEXT,
    prior_json TEXT,
    PRIMARY KEY (org_id, statement_id, seq),
    FOREIGN KEY (org_id, statement_id) REFERENCES kin_bank_statements (org_id, statement_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_statement_passwords (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    account_key TEXT NOT NULL,
    label TEXT NOT NULL,
    secret_name TEXT NOT NULL,
    remembered_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, account_key)
  )`;
});
