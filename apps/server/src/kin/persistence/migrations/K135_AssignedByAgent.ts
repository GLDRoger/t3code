import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The agent that gave a task to its holder, so handing it back reaches that agent. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_records ADD COLUMN assigned_by_agent_id TEXT`;
});
