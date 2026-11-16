import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Kin's GitHub App is gone; agents review as the owner. A review still waiting on its Post card is
 * declined and its card leaves chats and Waiting (dismissed, so synced clients drop it).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const at = DateTime.formatIso(DateTime.makeUnsafe(now));
  const cards = sql`SELECT widget_id FROM kin_pr_review_posts
    WHERE state = 'open' AND widget_id IS NOT NULL`;
  yield* sql`UPDATE kin_messages SET status = 'dismissed'
    WHERE status <> 'dismissed' AND (
      message_id IN (SELECT message_id FROM kin_widgets WHERE widget_id IN (${cards}))
      OR widget_id IN (${cards}))`;
  yield* sql`UPDATE kin_waiting SET resolved_at = ${at}, resolution = 'closed'
    WHERE resolved_at IS NULL AND widget_id IN (${cards})`;
  yield* sql`UPDATE kin_widgets SET closed_at = ${at}, awaiting_json = '[]', updated_at = ${at}
    WHERE closed_at IS NULL AND widget_id IN (${cards})`;
  yield* sql`UPDATE kin_pr_review_posts SET state = 'declined', decided_at = ${now}
    WHERE state = 'open'`;
});
