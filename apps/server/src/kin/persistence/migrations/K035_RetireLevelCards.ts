import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The level ladder is gone (owner, 10 Nov 2026): its server-drawn cards leave every chat and the
 * Waiting list. Their notice messages are dismissed rather than deleted so synced clients drop
 * them through `change_seq`; feeds never show dismissed messages. Shadow entries stay as history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const retired = sql`SELECT widget_id FROM kin_widgets
    WHERE type IN ('promotion', 'shadow_review', 'shadow_summary')`;
  yield* sql`UPDATE kin_messages SET status = 'dismissed'
    WHERE status <> 'dismissed' AND (
      message_id IN (SELECT message_id FROM kin_widgets WHERE widget_id IN (${retired}))
      OR widget_id IN (${retired})
      OR message_id LIKE 'kin-level-lowered:%')`;
  yield* sql`DELETE FROM kin_waiting WHERE widget_id IN (${retired})
    OR message_id IN (SELECT message_id FROM kin_widgets WHERE widget_id IN (${retired}))`;
  yield* sql`DELETE FROM kin_widgets WHERE widget_id IN (${retired})`;
});
