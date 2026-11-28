import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_lead_deliveries_next (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('reminder', 'routine', 'scheduled_task', 'card_tap')),
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
  yield* sql`INSERT INTO kin_lead_deliveries_next (
    org_id, event_id, kind, agent_id, chat_id, widget_id, widget_type, state_json,
    fallback_body, deadline_at, status, message_id, created_at, updated_at
  ) SELECT org_id, event_id, kind, agent_id, chat_id, widget_id, widget_type, state_json,
    fallback_body, deadline_at, status, message_id, created_at, updated_at
    FROM kin_lead_deliveries`;
  yield* sql`DROP TABLE kin_lead_deliveries`;
  yield* sql`ALTER TABLE kin_lead_deliveries_next RENAME TO kin_lead_deliveries`;
  yield* sql`CREATE INDEX idx_kin_lead_deliveries_pending
    ON kin_lead_deliveries(org_id, status, created_at)`;
});
