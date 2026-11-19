import {
  KIN_CHOICE_CARD_TTL_MS,
  type KinAgentId,
  type KinOrgId,
  type KinWidgetId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A teammate's requests this agent put to the owner on a route card (`routeCard.ts`) that the
 * owner answered not this time, read from Kin's rows when the turn is built: the agent's own
 * earlier words in the chat said they waited, and only this says they no longer do.
 */

export const DECLINED_RULE =
  "Requests of this person's that you passed on and Kin put to the owner on a card, which the owner answered not this time. This is Kin's record now and outranks anything said in the chat, your own words included: nothing about these waits on the owner or anyone. When one comes up again, say it was declined; never say it waits or that the owner has been asked. Pass a new message of theirs on only if it asks for something new, which puts it to the owner again.";

/** A "not this time" is about this time: by a working weekend later, a new ask is a new one. */
export const DECLINED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** One person's declines through one agent are few; past the newest three they are history. */
const DECLINED_CAP = 3;

export const declinedRequests = Effect.fn("KinLeadPrompt.declined")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const since = input.now - DECLINED_WINDOW_MS;
  const rows = yield* sql<{
    messageId: string;
    body: string;
    toAgentId: KinAgentId;
    agentName: string;
    personName: string;
    askedAt: string;
    widgetId: KinWidgetId | null;
    by: string | null;
    tappedAt: string | null;
  }>`SELECT h.message_id AS "messageId", m.body, h.to_agent_id AS "toAgentId",
      COALESCE(l.name, a.display_name, h.to_agent_id) AS "agentName",
      p.display_name AS "personName", m.created_at AS "askedAt",
      h.route_widget_id AS "widgetId", tp.display_name AS by, tm.created_at AS "tappedAt"
    FROM kin_handoffs h
    JOIN kin_messages m ON m.org_id = h.org_id AND m.message_id = h.message_id
    JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = m.author_person_id
    LEFT JOIN kin_leads l ON l.org_id = h.org_id AND l.agent_id = h.to_agent_id
    LEFT JOIN kin_agents a ON a.org_id = h.org_id AND a.agent_id = h.to_agent_id
    -- Who tapped and when; gone with a cleared owner chat, when the ask's time stands in.
    LEFT JOIN kin_card_plans c ON c.org_id = h.org_id AND c.widget_id = h.route_widget_id
      AND c.ran_message_id IS NOT NULL
    LEFT JOIN kin_messages tm ON tm.org_id = c.org_id AND tm.message_id = c.ran_message_id
    LEFT JOIN kin_people tp ON tp.org_id = tm.org_id AND tp.person_id = tm.author_person_id
    WHERE h.org_id = ${input.orgId} AND h.from_agent_id = ${input.agentId}
      AND h.route_state = 'declined' AND m.chat_id = ${input.chatId}
      AND m.author_kind = 'human' AND m.status = 'posted'
      -- A route card is answered within its life, so an older ask was declined before the window.
      AND h.created_at >= ${since - KIN_CHOICE_CARD_TTL_MS}
    ORDER BY h.created_at DESC, h.message_id`;
  return rows
    .map(({ tappedAt, askedAt, ...row }) => {
      const asked = Date.parse(askedAt);
      const answered = tappedAt === null ? undefined : Date.parse(tappedAt);
      return { ...row, askedAt: asked, answeredAt: answered, at: answered ?? asked };
    })
    .filter((row) => row.at > since)
    .slice(0, DECLINED_CAP)
    .map(({ at: _at, ...row }) => row);
});
