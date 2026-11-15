import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An agent's receipt that would record money received, kept as asked with the figures its card
 * showed, until the owner's tap on that card records it or says no; and statement password tries, counted per statement and per file in a chat,
 * so sending the same file again or reading it again never refills them. Counts kept on each
 * statement before this carry over.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_receipt_proposals (
    org_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    widget_id TEXT,
    proposed_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'made', 'declined')),
    decided_at INTEGER,
    receipt_key TEXT,
    PRIMARY KEY (org_id, proposal_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_receipt_proposals_widgets
    ON kin_receipt_proposals (org_id, widget_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_statement_password_budget (
    org_id TEXT NOT NULL,
    budget_key TEXT NOT NULL,
    remaining INTEGER NOT NULL,
    -- When an emptied budget fills again; NULL while tries are left.
    refill_at INTEGER,
    PRIMARY KEY (org_id, budget_key)
  )`;
  // One already out of tries may take passwords again at once, as sending it again did before.
  for (const [prefix, column] of [
    ["card:st:", "password_attempts"],
    ["chat:st:", "chat_password_attempts"],
  ] as const)
    yield* sql`INSERT OR IGNORE INTO kin_statement_password_budget
        (org_id, budget_key, remaining, refill_at)
      SELECT org_id, ${prefix} || statement_id, MAX(0, 5 - ${sql(column)}),
        CASE WHEN ${sql(column)} >= 5 THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 END
      FROM kin_bank_statements WHERE ${sql(column)} > 0`;
});
