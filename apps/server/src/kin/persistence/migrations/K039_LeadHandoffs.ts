import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One hand-off per owner message, whichever lead it went to: a retry finds where it went, and the
 * same message can't be passed to a second lead.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_handoffs (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    message_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, message_id)
  )`;
});
