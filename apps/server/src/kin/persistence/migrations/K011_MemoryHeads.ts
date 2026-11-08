import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_memory_heads (
    org_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    head TEXT NOT NULL,
    PRIMARY KEY (org_id, branch)
  )`;
});
