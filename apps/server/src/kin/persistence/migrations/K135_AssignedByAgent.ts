import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The agent that gave a task to its holder, so handing it back reaches that agent. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_records')`;
  if (!columns.some((column) => column.name === "assigned_by_agent_id"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN assigned_by_agent_id TEXT`;
});
