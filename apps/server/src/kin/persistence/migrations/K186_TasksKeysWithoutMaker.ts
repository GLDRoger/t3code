import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Ends every coding-agent key with no recorded maker: no device's removal could end it. Kin's row
 * only; its T3 session is useless without a live row here and lapses on its own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE kin_tasks_keys SET revoked_at = ${now}
    WHERE made_by_session_id IS NULL AND revoked_at IS NULL`;
});
