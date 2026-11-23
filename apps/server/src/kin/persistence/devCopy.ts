import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

// A person's own mailbox's send cards hold their mail: the copy keeps none of them, nor what
// waits on them. Sources from before own mailboxes have no `person_id` and nothing to drop.
export const dropPersonalSendCards = Effect.fn("dropPersonalSendCards")(function* (
  sql: SqlClient.SqlClient,
) {
  const [ready] = yield* sql<{ n: number }>`SELECT
      (SELECT COUNT(*) FROM pragma_table_info('kin_connections', 'src') WHERE name = 'person_id')
      + (SELECT COUNT(*) FROM src.sqlite_master WHERE type = 'table'
          AND name IN ('kin_connection_asks', 'kin_widgets')) AS n`;
  if ((ready?.n ?? 0) < 3) return;
  const cards = sql`SELECT k.widget_id FROM src.kin_connection_asks k
    JOIN src.kin_connections c ON c.org_id = k.org_id AND c.connection_id = k.connection_id
    WHERE c.person_id IS NOT NULL AND k.widget_id IS NOT NULL`;
  const [waiting] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM main.sqlite_master
    WHERE type = 'table' AND name = 'kin_waiting'`;
  if ((waiting?.n ?? 0) > 0) yield* sql`DELETE FROM main.kin_waiting WHERE widget_id IN (${cards})`;
  yield* sql`DELETE FROM main.kin_widgets WHERE widget_id IN (${cards})`;
});
