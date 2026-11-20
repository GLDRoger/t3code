import type { KinAgentId, KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type Pair = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly personId: KinPersonId;
};

/** Each person has one direct chat per lead, found by this key. */
export const directKey = (personId: KinPersonId, agentId: KinAgentId) => `${personId}:${agentId}`;

/** The org's team agent while it is a live lead: it answers in the company chat and for notices. */
const teamAgentSql = (sql: SqlClient.SqlClient, orgId: KinOrgId) => sql`(
    SELECT o.agent_id FROM kin_team_agents o
    JOIN kin_agents t ON t.org_id = o.org_id AND t.agent_id = o.agent_id
      AND t.role = 'lead' AND t.retired_at IS NULL
    WHERE o.org_id = ${orgId})`;

export const teamAgent = Effect.fn("KinLeadAccess.teamAgent")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ agentId: KinAgentId | null }>`
    SELECT ${teamAgentSql(sql, orgId)} AS "agentId"`;
  return row?.agentId ?? null;
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** Lead turns one teammate may ask for in any 24 hours, by message, tap or task, unless configured. */
const DEFAULT_TEAMMATE_DAILY_TURNS = 50;
export const dailyTurns = Config.Int("KIN_TEAMMATE_DAILY_TURNS").pipe(
  Config.withDefault(DEFAULT_TEAMMATE_DAILY_TURNS),
  Effect.map((value) => Math.max(0, value)),
  Effect.catch((cause) =>
    Effect.logWarning("KIN_TEAMMATE_DAILY_TURNS is not a number; using the default", {
      cause,
    }).pipe(Effect.as(DEFAULT_TEAMMATE_DAILY_TURNS)),
  ),
);

/**
 * The lead turns this person's messages, taps, tasks and asked reviews have asked for in the last 24 hours, in every
 * chat and of every lead they do not own: messages answered in one turn count once, dropped ones
 * not at all.
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
    WHERE e.org_id = ${input.orgId} AND e.state <> 'expired' AND e.received_at > ${input.now - DAY_MS}
      AND ((e.tag IN ('chat.message', 'widget.action', 'record.changed')
          AND json_extract(e.json, '$.provenance.personId') = ${input.personId})
        OR (e.tag = 'github' AND json_extract(e.json, '$.askedBy') = ${input.personId}))
      AND a.owner_person_id <> ${input.personId}`;
  return { turns: row?.turns ?? 0, oldestAt: row?.oldestAt ?? null };
});

/**
 * A person's messages, tasks, answers and asked reviews still waiting for the lead in their
 * direct chat never run, nor do those an aborted turn holds, which its finish would otherwise put
 * back on the queue.
 */
export const dropQueued = Effect.fn("KinLeadAccess.dropQueued")(function* (
  pair: Pick<Pair, "orgId" | "agentId">,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const dropped = yield* sql`UPDATE kin_events AS e SET state = 'expired'
    WHERE e.org_id = ${pair.orgId} AND e.agent_id = ${pair.agentId}
      AND (e.state = 'queued' OR (e.state = 'claimed' AND EXISTS (SELECT 1 FROM kin_wakeups w
        WHERE w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id AND w.aborted_at IS NOT NULL)))
      AND ((e.tag IN ('chat.message', 'widget.action', 'chat.reaction', 'record.changed',
            'deferral.due')
          AND json_extract(e.json, '$.chatId') = ${chatId})
        OR (e.tag = 'github' AND EXISTS (SELECT 1 FROM kin_chats c WHERE c.org_id = e.org_id
          AND c.chat_id = ${chatId} AND c.kind = 'direct'
          AND c.direct_key = json_extract(e.json, '$.askedBy') || ':' || e.agent_id)))
    RETURNING event_id`;
  return dropped.length;
});
