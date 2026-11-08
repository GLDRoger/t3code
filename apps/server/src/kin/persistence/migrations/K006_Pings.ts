import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE kin_ping_items (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      person TEXT NOT NULL,
      item_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      first_day TEXT,
      first_seq INTEGER,
      stopped_at INTEGER,
      PRIMARY KEY (org_id, person, item_id)
    )
  `;
  yield* sql`
    CREATE TABLE kin_ping_escalations (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      item_id TEXT NOT NULL,
      waiting_id TEXT NOT NULL REFERENCES kin_waiting(waiting_id),
      escalated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, item_id)
    )
  `;
  yield* sql`CREATE INDEX idx_kin_ping_items_item ON kin_ping_items(org_id, item_id)`;
  yield* sql`CREATE INDEX idx_kin_ping_items_pending ON kin_ping_items(org_id, person, item_id) WHERE stopped_at IS NULL`;
  yield* sql`CREATE TABLE kin_ping_deliveries (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    person TEXT NOT NULL,
    item_id TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES kin_messages(message_id),
    seq INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    PRIMARY KEY (org_id, person, item_id, message_id)
  )`;
});
