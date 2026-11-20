import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Kin's own bank alert cards, by id. The server answers them, so a tap on one wakes no agent. */
export const SENDER_CARD = "kin-bank-alert-sender:";
export const PAY_CARD = "kin-bank-alert-pay:";
export const isAlertCard = (widgetId: string) =>
  widgetId.startsWith(SENDER_CARD) || widgetId.startsWith(PAY_CARD);

type Said = {
  readonly messageId: string;
  readonly widgetId: string | null;
  readonly kind: string;
  readonly body: string;
};
const cardOf = (message: Said) => message.widgetId ?? message.messageId;

/**
 * Chat as a model is handed it: a bank alert card, or a tap on one, is one fixed sentence with no
 * party, amount, day or digits. An agent that wants the facts reads Money, which marks its turn.
 */
export const alertCardsForModel = Effect.fn("KinBankAlerts.forModel")(function* <M extends Said>(
  orgId: KinOrgId,
  messages: ReadonlyArray<M>,
) {
  const cards = [...new Set(messages.map(cardOf).filter(isAlertCard))];
  if (cards.length === 0) return messages;
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND access = 'owner' ORDER BY created_at, person_id LIMIT 1`;
  const first = (owner?.name ?? "").trim().split(/\s+/)[0] || "the owner";
  const open = new Set(
    (yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId" FROM kin_widgets
      WHERE org_id = ${orgId} AND widget_id IN ${sql.in(cards)} AND closed_at IS NULL
        AND json_extract(state_json, '$.answer') IS NULL
      ORDER BY widget_id`).map((row) => row.widgetId),
  );
  return messages.map((message) => {
    const card = cardOf(message);
    if (!isAlertCard(card)) return message;
    const waiting = message.kind !== "widget_action" && open.has(card);
    return {
      ...message,
      body: waiting
        ? `A bank alert card is waiting for ${first}'s answer.`
        : `A bank alert card was answered.`,
    };
  });
});
