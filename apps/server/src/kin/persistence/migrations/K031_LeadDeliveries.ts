import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A message the lead should write, with the card the server attaches to it, or its fallback.
  yield* sql`CREATE TABLE kin_lead_deliveries (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('reminder', 'routine', 'scheduled_task')),
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    widget_id TEXT NOT NULL,
    widget_type TEXT NOT NULL,
    state_json TEXT NOT NULL,
    fallback_body TEXT NOT NULL,
    deadline_at INTEGER NOT NULL CHECK (typeof(deadline_at) = 'integer'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'fallback')),
    message_id TEXT,
    created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
    updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
    PRIMARY KEY (org_id, event_id)
  )`;
  yield* sql`CREATE INDEX idx_kin_lead_deliveries_pending
    ON kin_lead_deliveries(org_id, status, created_at)`;
  // Server state of a scheduled task; the task itself is a memory item, armed from the cache.
  yield* sql`CREATE TABLE kin_scheduled_tasks (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    item_id TEXT NOT NULL,
    chat_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('active', 'deleted', 'disarmed')),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    recorded_at TEXT NOT NULL,
    run_now_at INTEGER CHECK (run_now_at IS NULL OR typeof(run_now_at) = 'integer'),
    updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
    PRIMARY KEY (org_id, item_id)
  )`;
});
