import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { chatShared } from "../chat/sharing.ts";

/**
 * In the change that took owner-level from `personId`: every ask still waiting on its Confirm in
 * a chat they are or were in that is no longer owner-only goes stale with `reason`, as its
 * outcome could no longer be written there. The ids of their cards, for the caller to close.
 */
export const staleAsksStranded = Effect.fn("KinConnections.staleAsksStranded")(function* (
  orgId: KinOrgId,
  personId: string,
  reason: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const open = yield* sql<{ askId: string; chatId: string; widgetId: string | null }>`SELECT
      k.ask_id AS "askId", k.chat_id AS "chatId", k.widget_id AS "widgetId"
    FROM kin_connection_asks k
    WHERE k.org_id = ${orgId} AND k.state = 'open'
      AND EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = k.org_id
        AND m.chat_id = k.chat_id AND m.principal_kind = 'person' AND m.person_id = ${personId})
      AND NOT EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = k.org_id
        AND w.widget_id = k.widget_id AND w.closed_at IS NOT NULL)
    ORDER BY k.ask_id`;
  const shared = new Set<string>();
  for (const chatId of new Set(open.map((one) => one.chatId)))
    if (yield* chatShared(sql, { orgId, chatId })) shared.add(chatId);
  const stranded = open.filter((one) => shared.has(one.chatId));
  if (stranded.length === 0) return [];
  yield* sql`UPDATE kin_connection_asks SET state = 'stale', reason = ${reason}, decided_at = ${now}
    WHERE org_id = ${orgId} AND state = 'open'
      AND ask_id IN ${sql.in(stranded.map((one) => one.askId))}`;
  return stranded.flatMap((one) => (one.widgetId === null ? [] : [one.widgetId]));
});
