import type { KinMessageId, KinOrgId, KinWidgetId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { replaceSystemNotice } from "../chat/systemNotice.ts";

const SET = " is set.";

export const standingReminderBody = (asker: string) => `A reminder ${asker} asked for${SET}`;

export const settleStandingReminder = Effect.fn("KinReminder.settleStandingNotice")(function* (
  input: { readonly orgId: KinOrgId; readonly widgetId: KinWidgetId; readonly at: string },
  outcome: "done" | "undone",
) {
  const sql = yield* SqlClient.SqlClient;
  const prefix = `${input.widgetId}:moved:`;
  const rows = yield* sql<{ messageId: KinMessageId; body: string }>`
    SELECT message_id AS "messageId", body FROM kin_messages
    WHERE org_id = ${input.orgId} AND message_id >= ${prefix} AND message_id < ${`${input.widgetId}:moved;`}
      AND author_kind = 'system' AND kind = 'system' AND status = 'posted'
      AND body LIKE 'A reminder % asked for is set.'`;
  for (const { messageId, body } of rows)
    yield* replaceSystemNotice({
      ...input,
      messageId,
      before: body,
      body: body.slice(0, -SET.length) + (outcome === "done" ? " is done." : " was undone."),
    });
});
