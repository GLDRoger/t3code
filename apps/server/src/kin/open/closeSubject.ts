import { type KinOrgId, KinWidgetId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { KinChatService } from "../chat/KinChatService.ts";
import { staleAsksAbout } from "../connections/ConnectionRows.ts";
import { closeQuestionsAbout } from "../questions/openQuestions.ts";
import { listDef, stateLabel } from "../work/registers.ts";

export type ClosedSubject = {
  readonly orgId: KinOrgId;
  readonly recordId: string;
  readonly key: string;
  readonly registerId: string;
  /** The closed state it just moved to: `done` or `dropped`. */
  readonly state: string;
  /** Cards the tap making this move settles itself. */
  readonly sparing: ReadonlyArray<string>;
  readonly now: number;
};

/**
 * In the state move's own transaction: what was open about an entry that just closed closes with
 * it, each card saying why. Its mail asks go stale and its receipt cards close only when it is
 * dropped (void), as Confirm would refuse them; a done one's copy still goes. A card some of whose actions are about other
 * things keeps them, and a tap on its dead one says what changed. Reopening brings none back.
 */
export const closeSubject = Effect.fn("KinOpen.closeSubject")(function* (
  input: ClosedSubject,
  chat: Pick<KinChatService["Service"], "dismissArrival" | "closeReplaced">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, recordId, key, state, now } = input;
  const def = yield* listDef(orgId, input.registerId);
  const word = (def === undefined ? state : stateLabel(def, state)).toLowerCase();
  // A doc's only closed state is deleted: a card for its draft can't be confirmed any more.
  const doc = input.registerId === "docs";
  const title = doc
    ? "Deleted with its draft"
    : input.registerId === "work"
      ? "Closed with its task"
      : "Closed";
  const text = doc ? `${title}: ${key} was deleted.` : `${title}: ${key} is ${word} now.`;
  const asks =
    state === "dropped"
      ? yield* staleAsksAbout(
          orgId,
          recordId,
          doc
            ? `${key} was deleted, so nothing was sent.`
            : `${key} is ${word} now, so nothing was sent.`,
          now,
        )
      : [];
  // Open choice cards (few, by the type and closed index) with every action about this entry.
  const plans = yield* sql<{ widgetId: string; target: string | null }>`SELECT
      p.widget_id AS "widgetId",
      COALESCE(json_extract(p.plan_json, '$.recordId'),
        json_extract(p.plan_json, '$.final.recordId')) AS target
    FROM kin_widgets w JOIN kin_card_plans p ON p.org_id = w.org_id
      AND p.widget_id = w.widget_id AND p.chat_id = w.chat_id
    WHERE w.type = 'choice' AND w.closed_at IS NULL AND w.org_id = ${orgId}
      AND p.ran_message_id IS NULL
    ORDER BY p.widget_id, p.option_id`;
  // Open receipt cards for it or set against it: once it is void their Confirm only refuses.
  const receipts =
    state === "dropped"
      ? yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId"
          FROM kin_receipt_proposals
          WHERE org_id = ${orgId} AND state = 'open' AND widget_id IS NOT NULL
            AND (json_extract(request_json, '$.against') = ${key}
              OR json_extract(request_json, '$.key') = ${key})
          ORDER BY widget_id`
      : [];
  const cards = [
    ...new Set([
      ...plans
        .map((one) => one.widgetId)
        .filter((widgetId) =>
          plans.every((one) => one.widgetId !== widgetId || one.target === recordId),
        ),
      ...receipts.map((one) => one.widgetId),
    ]),
  ].filter((widgetId) => !input.sparing.includes(widgetId));
  yield* closeQuestionsAbout(
    { orgId, key, cards, sparing: input.sparing, text, closedAt: now, title },
    chat,
  );
  const outcome = { title, text };
  for (const widgetId of new Set([...asks, ...cards]))
    yield* chat.closeReplaced({ orgId, widgetId: KinWidgetId.make(widgetId), outcome });
});
