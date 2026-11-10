import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_chats)`;
  // The lead that answers a group message naming nobody. Null follows the first lead who joined.
  if (!columns.some((column) => column.name === "lead_agent_id"))
    yield* sql`ALTER TABLE kin_chats ADD COLUMN lead_agent_id TEXT REFERENCES kin_agents(agent_id)`;
});
