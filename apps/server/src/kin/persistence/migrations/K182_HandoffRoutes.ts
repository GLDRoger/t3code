import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A teammate's request routed to the agent that owns it: where it stands (`route_state`), the
 * owner's card while it waits, and the one ask to the owner side about it. NULL on every other
 * hand-off. A message Kin posted again for a person says where it came from (`origin_json`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const handoffs = yield* sql<{ name: string }>`PRAGMA table_info(kin_handoffs)`;
  if (!handoffs.some((column) => column.name === "route_state"))
    yield* sql`ALTER TABLE kin_handoffs ADD COLUMN route_state TEXT NULL
      CHECK (route_state IN ('pending', 'passed', 'declined', 'stale', 'waited'))`;
  if (!handoffs.some((column) => column.name === "route_widget_id"))
    yield* sql`ALTER TABLE kin_handoffs ADD COLUMN route_widget_id TEXT NULL`;
  if (!handoffs.some((column) => column.name === "asked_message_id"))
    yield* sql`ALTER TABLE kin_handoffs ADD COLUMN asked_message_id TEXT NULL`;
  const messages = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  if (!messages.some((column) => column.name === "origin_json"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN origin_json TEXT NULL`;
});
