import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_looks (
    org_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    looked_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, person_id, record_id)
  )`;
});
