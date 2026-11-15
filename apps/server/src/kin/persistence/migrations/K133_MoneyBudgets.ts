import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Monthly spending limits the owner set, per expense category, project, or both, in one currency.
 * Removing one deletes its row; what was spent is always read from the expenses themselves. Each
 * owner message that set or removed one keeps a receipt, so its retry repeats the same outcome.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_money_budgets (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    budget_id TEXT NOT NULL,
    category TEXT,
    project_id TEXT,
    currency TEXT NOT NULL,
    limit_minor INTEGER NOT NULL CHECK (limit_minor >= 0),
    set_by_kind TEXT NOT NULL,
    set_by_id TEXT,
    set_at INTEGER NOT NULL,
    CHECK (category IS NOT NULL OR project_id IS NOT NULL),
    PRIMARY KEY (org_id, budget_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_money_budget_receipts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    source_event_id TEXT NOT NULL,
    target_key TEXT NOT NULL,
    budget_id TEXT,
    currency TEXT,
    limit_minor INTEGER,
    was_minor INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('set', 'removed', 'none')),
    at INTEGER NOT NULL,
    PRIMARY KEY (org_id, source_event_id, target_key)
  )`;
});
