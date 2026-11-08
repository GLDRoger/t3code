import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_lead_tool_calls (
    org_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    call_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    PRIMARY KEY (org_id, wakeup_id, call_key),
    FOREIGN KEY (org_id, wakeup_id) REFERENCES kin_wakeups(org_id, wakeup_id)
  )`;
});
