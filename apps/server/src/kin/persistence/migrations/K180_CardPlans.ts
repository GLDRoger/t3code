import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The fixed action a choice card's option runs when tapped, sealed when the card was drawn, and
 * the first tap's message once it ran. Server-only: no client or agent payload reads this table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_card_plans (
    org_id TEXT NOT NULL, widget_id TEXT NOT NULL, option_id TEXT NOT NULL,
    chat_id TEXT NOT NULL, plan_json TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
    ran_message_id TEXT NULL,
    PRIMARY KEY (org_id, widget_id, option_id)
  )`;
});
