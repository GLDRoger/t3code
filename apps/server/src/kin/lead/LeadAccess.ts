import type { KinAgentId, KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who besides its owner may message a lead (`kin_lead_access`). The owner allows a person per
 * lead; without a live row only the owner's messages reach it. Read from stored rows only.
 */
type Pair = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly personId: KinPersonId;
};

/** Each person has one direct chat per lead, found by this key. */
export const directKey = (personId: KinPersonId, agentId: KinAgentId) => `${personId}:${agentId}`;

/** Whether the lead's owner lets this person message it now. The owner needs no row. */
export const allowed = Effect.fn("KinLeadAccess.allowed")(function* (pair: Pair) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_lead_access x
    JOIN kin_agents a ON a.org_id = x.org_id AND a.agent_id = x.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE x.org_id = ${pair.orgId} AND x.agent_id = ${pair.agentId}
      AND x.person_id = ${pair.personId} AND x.revoked_at IS NULL
    LIMIT 1`;
  return rows.length > 0;
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The lead turns this person's direct messages have asked for in the last 24 hours, across every
 * lead they may message: messages answered in one turn count once, dropped ones not at all.
 * `oldestAt` is when the earliest of them was sent, so the window is known to move on.
 */
export const recentTurns = Effect.fn("KinLeadAccess.recentTurns")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ turns: number; oldestAt: number | null }>`
    SELECT COUNT(DISTINCT COALESCE(e.wakeup_id, e.event_id)) AS turns,
      MIN(e.received_at) AS "oldestAt"
    FROM kin_events e
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    JOIN kin_chats c ON c.org_id = e.org_id AND c.chat_id = json_extract(e.json, '$.chatId')
      AND c.kind = 'direct'
    WHERE e.org_id = ${input.orgId} AND e.tag IN ('chat.message', 'widget.action')
      AND e.state <> 'expired' AND e.received_at > ${input.now - DAY_MS}
      AND json_extract(e.json, '$.provenance.personId') = ${input.personId}
      AND a.owner_person_id <> ${input.personId}`;
  return { turns: row?.turns ?? 0, oldestAt: row?.oldestAt ?? null };
});

/** A person's messages still waiting for the lead in their direct chat never run. */
export const dropQueued = Effect.fn("KinLeadAccess.dropQueued")(function* (
  pair: Pick<Pair, "orgId" | "agentId">,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const dropped = yield* sql`UPDATE kin_events SET state = 'expired'
    WHERE org_id = ${pair.orgId} AND agent_id = ${pair.agentId} AND state = 'queued'
      AND tag IN ('chat.message', 'widget.action', 'chat.reaction')
      AND json_extract(json, '$.chatId') = ${chatId}
    RETURNING event_id`;
  return dropped.length;
});
