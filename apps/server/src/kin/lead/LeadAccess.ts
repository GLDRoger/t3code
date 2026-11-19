import type { KinAgentId, KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

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

/** The org's team agent while it is a live lead: everyone in the org may message it. */
export const teamAgentSql = (sql: SqlClient.SqlClient, orgId: KinOrgId) => sql`(
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

/** The owner put them in a group together, so an answer taken private can go on there. */
const sharesGroupSql = (
  sql: SqlClient.SqlClient,
  org: Statement.Fragment | KinOrgId,
  agent: Statement.Fragment | KinAgentId,
  personId: KinPersonId,
) => sql`EXISTS (SELECT 1 FROM kin_chat_members ma
    JOIN kin_chats c ON c.org_id = ma.org_id AND c.chat_id = ma.chat_id
      AND c.kind <> 'direct' AND c.archived_at IS NULL
    JOIN kin_chat_members mp ON mp.org_id = ma.org_id AND mp.chat_id = ma.chat_id
      AND mp.principal_kind = 'person' AND mp.person_id = ${personId}
      AND mp.left_at IS NULL
    WHERE ma.org_id = ${org} AND ma.principal_kind = 'agent' AND ma.agent_id = ${agent}
      AND ma.left_at IS NULL)`;

/**
 * Whether this person may message the lead now: its owner let them, it is the team agent, or
 * they are both in a group.
 * The owner needs neither.
 */
export const allowed = Effect.fn("KinLeadAccess.allowed")(function* (pair: Pair) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_agents a
    WHERE a.org_id = ${pair.orgId} AND a.agent_id = ${pair.agentId}
      AND a.role = 'lead' AND a.retired_at IS NULL
      AND (a.agent_id = ${teamAgentSql(sql, pair.orgId)} OR EXISTS (
        SELECT 1 FROM kin_lead_access x WHERE x.org_id = a.org_id AND x.agent_id = a.agent_id
          AND x.person_id = ${pair.personId} AND x.revoked_at IS NULL)
        OR ${sharesGroupSql(sql, sql.literal("a.org_id"), sql.literal("a.agent_id"), pair.personId)})
    LIMIT 1`;
  return rows.length > 0;
});

/** How the person reaches the lead besides their own row, if they do. */
export const otherWay = Effect.fn("KinLeadAccess.otherWay")(function* (pair: Pair) {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* teamAgent(pair.orgId)) === pair.agentId) return "team" as const;
  const [row] = yield* sql<{ shared: number }>`SELECT
    ${sharesGroupSql(sql, pair.orgId, pair.agentId, pair.personId)} AS shared`;
  return row?.shared === 1 ? ("group" as const) : null;
});

/** Whether the person's own row lets them message the lead, whatever the team agent is. */
export const granted = Effect.fn("KinLeadAccess.granted")(function* (pair: Pair) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_lead_access x
    WHERE x.org_id = ${pair.orgId} AND x.agent_id = ${pair.agentId}
      AND x.person_id = ${pair.personId} AND x.revoked_at IS NULL
    LIMIT 1`;
  return rows.length > 0;
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
 * The lead turns this person's messages, taps and tasks have asked for in the last 24 hours, in every
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
    WHERE e.org_id = ${input.orgId} AND e.tag IN ('chat.message', 'widget.action', 'record.changed')
      AND e.state <> 'expired' AND e.received_at > ${input.now - DAY_MS}
      AND json_extract(e.json, '$.provenance.personId') = ${input.personId}
      AND a.owner_person_id <> ${input.personId}`;
  return { turns: row?.turns ?? 0, oldestAt: row?.oldestAt ?? null };
});

/** A person's messages and tasks still waiting for the lead in their direct chat never run. */
export const dropQueued = Effect.fn("KinLeadAccess.dropQueued")(function* (
  pair: Pick<Pair, "orgId" | "agentId">,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const dropped = yield* sql`UPDATE kin_events SET state = 'expired'
    WHERE org_id = ${pair.orgId} AND agent_id = ${pair.agentId} AND state = 'queued'
      AND tag IN ('chat.message', 'widget.action', 'chat.reaction', 'record.changed')
      AND json_extract(json, '$.chatId') = ${chatId}
    RETURNING event_id`;
  return dropped.length;
});
