import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE kin_memory_reads (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      item_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL CHECK (typeof(last_read_at) = 'integer'),
      PRIMARY KEY (org_id, item_id)
    )
  `;
});
