import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The worker attempts an owner's withdrawal covers, written in the withdrawal's own transaction:
 * the stop reaches exactly these, a restart replays only `pending` ones, and any row bars that
 * attempt from publishing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_worker_withdrawals (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    record_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer'),
    worker_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    record_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'failed')),
    created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
    PRIMARY KEY (org_id, record_id, seq, worker_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_worker_withdrawals_attempt
    ON kin_worker_withdrawals (org_id, worker_id, started_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_worker_withdrawals_pending
    ON kin_worker_withdrawals (state) WHERE state = 'pending'`;
});
