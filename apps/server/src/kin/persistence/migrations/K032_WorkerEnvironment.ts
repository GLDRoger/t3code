import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The linked environment a worker's thread runs in, written before the launch there.
  yield* sql`ALTER TABLE kin_workers ADD COLUMN environment_id TEXT`;
  // The lead's worker project on this host the work was for, rechecked on every follow-up.
  yield* sql`ALTER TABLE kin_workers ADD COLUMN project_id TEXT`;
  // That environment's project, so recovery can find a launch whose reply was lost.
  yield* sql`ALTER TABLE kin_workers ADD COLUMN remote_project_id TEXT`;
  // The project's repository (`github.com/<owner>/<repo>`); the card links only its PRs.
  yield* sql`ALTER TABLE kin_workers ADD COLUMN repository_key TEXT`;
});
