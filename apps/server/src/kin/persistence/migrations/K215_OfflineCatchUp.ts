import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_org_state)`;
  if (!columns.some((column) => column.name === "last_alive_at"))
    yield* sql`ALTER TABLE kin_org_state ADD COLUMN last_alive_at INTEGER`;
  if (!columns.some((column) => column.name === "offline_notices_json"))
    yield* sql`ALTER TABLE kin_org_state ADD COLUMN offline_notices_json TEXT NOT NULL DEFAULT '[]'`;
  // Heartbeat-only rows do not participate in the stop switch startup fan-out.
  if (!columns.some((column) => column.name === "stop_managed"))
    yield* sql`ALTER TABLE kin_org_state ADD COLUMN stop_managed INTEGER NOT NULL DEFAULT 1`;
});
