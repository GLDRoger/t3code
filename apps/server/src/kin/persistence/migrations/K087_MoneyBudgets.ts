import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Monthly spending limits the owner set, per expense category, project, or both, in one currency.
 * Removing one deletes its row; what was spent is always read from the expenses themselves.
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
});
