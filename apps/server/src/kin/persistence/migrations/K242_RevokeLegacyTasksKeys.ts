import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keys made before this instant were issued for a narrower set of tools.
const cutOff = Date.parse("2026-11-23T21:12:12.000Z");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Kin can migrate before T3 on a new database, where no sessions have been issued.
  const sessions =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'`;
  if (sessions.length === 0) return;

  const now = yield* DateTime.now;
  yield* sql`UPDATE auth_sessions SET revoked_at = ${DateTime.formatIso(now)}
    WHERE revoked_at IS NULL AND session_id IN (
      SELECT session_id FROM kin_tasks_keys WHERE created_at < ${cutOff}
    )`;
  yield* sql`UPDATE kin_tasks_keys SET revoked_at = ${now.epochMilliseconds}
    WHERE revoked_at IS NULL AND created_at < ${cutOff}`;
});
