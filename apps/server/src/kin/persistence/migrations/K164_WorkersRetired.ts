import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Kin's workers are gone (T3's delegated tasks replace them). Open runs end failed, a Work entry
 * keeps its worker's PR, publish cards leave chats and Waiting (dismissed, so synced clients drop
 * them), and task usage is charged per thread. The old tables stay as history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const at = DateTime.formatIso(DateTime.makeUnsafe(now));
  yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${now} WHERE ended_at IS NULL`;
  // An entry a worker's PR belongs to keeps that PR, so the merge still closes it.
  yield* sql`INSERT OR IGNORE INTO kin_record_links
      (org_id, record_id, kind, target, relation, chat_id, label, created_at)
    SELECT l.org_id, l.record_id, 'pull_request', k.pull_request_url, 'attempt', l.chat_id,
      'PR #' || k.pull_request_number, l.created_at
    FROM kin_record_links l
    JOIN kin_workers k ON k.org_id = l.org_id AND k.worker_id = l.target
    WHERE l.kind = 'worker' AND k.pull_request_url IS NOT NULL`;
  yield* sql`UPDATE kin_events SET state = 'done'
    WHERE tag = 'worker.report' AND state IN ('queued', 'claimed')`;
  const cards = sql`SELECT widget_id FROM kin_widgets WHERE type = 'worker_publish'`;
  yield* sql`UPDATE kin_messages SET status = 'dismissed'
    WHERE status <> 'dismissed' AND (
      message_id IN (SELECT message_id FROM kin_widgets WHERE widget_id IN (${cards}))
      OR widget_id IN (${cards}))`;
  yield* sql`UPDATE kin_waiting SET resolved_at = ${at}, resolution = 'closed'
    WHERE resolved_at IS NULL AND widget_id IN (${cards})`;
  yield* sql`UPDATE kin_widgets SET closed_at = ${at}, awaiting_json = '[]', updated_at = ${at}
    WHERE type = 'worker_publish' AND closed_at IS NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_task_charges (
    org_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    day TEXT NOT NULL,
    units REAL NOT NULL CHECK (units >= 0),
    tokens_json TEXT NOT NULL,
    PRIMARY KEY (org_id, thread_id),
    FOREIGN KEY (org_id, day) REFERENCES kin_budget(org_id, day)
  )`;
});
