import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The linked environment a worker's thread runs in; NULL until its launch there returns.
  yield* sql`ALTER TABLE kin_workers ADD COLUMN environment_id TEXT`;
  // The lead's worker project on this host the work was for, rechecked on every follow-up.
  yield* sql`ALTER TABLE kin_workers ADD COLUMN project_id TEXT`;
});
