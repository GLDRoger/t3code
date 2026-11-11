import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per worker attempt (`kin_workers.started_at`): its stop, each publish write's intent and
 * outcome, and whether the owner was told what reached GitHub. The row, not process memory, orders
 * a stop against a write, so a restart reads the same answer. K059's withdrawals become stops here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_worker_attempts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    worker_id TEXT NOT NULL,
    started_at INTEGER NOT NULL CHECK (typeof(started_at) = 'integer'),
    agent_id TEXT NOT NULL,
    source_event_id TEXT,
    withdrawn_at INTEGER,
    stopped_at INTEGER,
    stop_reason TEXT,
    stop_key TEXT,
    stop_label TEXT,
    stop_state TEXT CHECK (stop_state IN ('pending', 'sent', 'failed')),
    intent TEXT CHECK (intent IN ('commit', 'push', 'pull_request')),
    intent_sha TEXT,
    committed_sha TEXT,
    pushed_sha TEXT,
    pull_request_number INTEGER,
    pull_request_url TEXT,
    unchecked_at INTEGER,
    noticed_at INTEGER,
    PRIMARY KEY (org_id, worker_id, started_at),
    CHECK ((stopped_at IS NULL) = (stop_state IS NULL)),
    CHECK ((stopped_at IS NULL) = (stop_key IS NULL))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_worker_attempts_withdrawn_source
    ON kin_worker_attempts (org_id, agent_id, source_event_id) WHERE withdrawn_at IS NOT NULL`;
  const merged = yield* sql`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'kin_worker_withdrawals'`;
  if (merged.length === 0) return;
  yield* sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id,
      withdrawn_at, stopped_at, stop_reason, stop_key, stop_label, stop_state)
    SELECT org_id, worker_id, started_at, MIN(agent_id), MIN(created_at), MIN(created_at),
      'The owner closed this work or took it back.', 'kin-withdrawn:' || worker_id || ':' || MIN(seq),
      MIN(record_key),
      CASE WHEN SUM(state = 'pending') > 0 THEN 'pending'
        WHEN SUM(state = 'failed') > 0 THEN 'failed' ELSE 'sent' END
    FROM kin_worker_withdrawals GROUP BY org_id, worker_id, started_at
    ON CONFLICT (org_id, worker_id, started_at) DO NOTHING`;
  yield* sql`DROP TABLE kin_worker_withdrawals`;
});
