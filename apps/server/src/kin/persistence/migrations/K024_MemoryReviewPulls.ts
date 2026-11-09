import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The commit Kin pushed to each `kin/write/*-review` branch it left open for the owner.
  yield* sql`CREATE TABLE kin_memory_review_pulls (
    org_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    head TEXT NOT NULL,
    PRIMARY KEY (org_id, branch)
  )`;
});
