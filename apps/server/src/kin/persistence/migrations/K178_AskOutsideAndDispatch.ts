import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `outside_from`: the outside text the turn had read when it drew the card, which is why Confirm
 * was required. `dispatched_at`: when the confirmed send was claimed, so it starts once and a
 * restart can tell a send that never started from one whose outcome is unknown.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_connection_asks)`;
  if (!columns.some((column) => column.name === "outside_from"))
    yield* sql`ALTER TABLE kin_connection_asks ADD COLUMN outside_from TEXT`;
  if (!columns.some((column) => column.name === "dispatched_at")) {
    yield* sql`ALTER TABLE kin_connection_asks ADD COLUMN dispatched_at INTEGER`;
    // A send under way at the upgrade may have gone: it reads as started, not as never sent.
    yield* sql`UPDATE kin_connection_asks SET dispatched_at = decided_at WHERE state = 'sending'`;
  }
});
