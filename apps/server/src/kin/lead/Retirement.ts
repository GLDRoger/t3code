import {
  type KinAgentId,
  type KinChatId,
  KinMessageId,
  type KinOrgId,
  KinWakeupId,
  type KinWorkerId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { stopAttempt } from "../work/workerAttempts.ts";

/**
 * What retiring an agent does to everything it has in flight, inside the transaction that sets
 * `retired_at`, and what restoring it undoes. Its chats, history, memory and Work entries stay.
 */

/** Why its open workers stopped; the owner's stop notice quotes it. */
export const RETIRED_WORKER_REASON = "This agent was retired.";
export const retiredWorkerKey = (workerId: KinWorkerId, retiredAt: string) =>
  `kin-retired:${workerId}:${retiredAt}`;
/** Why its approval requests closed, on the request and in the audit log. */
export const RETIRED_ACTION_REASON = "agent_retired";

/**
 * Closes the approval requests a retired agent raised, in the retirement's transaction. The
 * approvals module provides it, so no lead module reaches pending actions (GrantVerifier.test).
 */
export class KinRetiredActions extends Context.Service<
  KinRetiredActions,
  {
    readonly close: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
    }) => Effect.Effect<void, SqlError.SqlError | PersistenceSqlError | PersistenceDecodeError>;
  }
>()("t3/kin/lead/Retirement/KinRetiredActions") {}

export const RETIRED_NOTICE_PREFIX = "kin-retired:";
export const retiredNoticeId = (messageId: KinMessageId) =>
  KinMessageId.make(`${RETIRED_NOTICE_PREFIX}${messageId}`);
/** Kin's line, never the model's, when someone writes to a retired agent in their chat with it. */
export const retiredAgentNotice = (name: string) =>
  `${name} has been retired, so it won't see this or reply.`;

/** The owner chat of a retired agent that no live one shares: its pings wait for a restore. */
export const retiredOwnerChat = (sql: SqlClient.SqlClient, orgId: KinOrgId, chatId: KinChatId) =>
  sql`SELECT 1 FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND l.owner_chat_id = ${chatId} AND a.retired_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM kin_leads o JOIN kin_agents b ON b.org_id = o.org_id
        AND b.agent_id = o.agent_id AND b.retired_at IS NULL
        WHERE o.org_id = l.org_id AND o.owner_chat_id = l.owner_chat_id)
    LIMIT 1`;

/** Chats the agent is in where no live agent remains to answer a timer: their timers wait. */
const heldChats = (sql: SqlClient.SqlClient, orgId: KinOrgId, agentId: KinAgentId) =>
  sql`SELECT m.chat_id FROM kin_chat_members m
    WHERE m.org_id = ${orgId} AND m.principal_kind = 'agent' AND m.agent_id = ${agentId}
      AND m.left_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM kin_chat_members o JOIN kin_agents a ON a.org_id = o.org_id
        AND a.agent_id = o.agent_id AND a.role = 'lead' AND a.retired_at IS NULL
        WHERE o.org_id = m.org_id AND o.chat_id = m.chat_id AND o.principal_kind = 'agent'
          AND o.left_at IS NULL)`;

/**
 * In the retirement's transaction, after `retired_at` is set. Returns the running wake-ups the
 * caller stops after commit (`KinStop.abortTurns`) and whether any queued event expired.
 */
export const retire = Effect.fn("KinRetirement.retire")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly retiredAt: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, now } = input;
  // Its turns under way, as a join aborts one: nothing more lands anywhere, memory is discarded.
  // `retired_at` outlives a restore, so what such a turn sent meanwhile still starts stopped.
  const turns = yield* sql<{ wakeupId: string }>`
    UPDATE kin_wakeups SET aborted_at = ${now}, retired_at = ${now},
      shared_since = COALESCE(shared_since, ${now})
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND status = 'running'
      AND aborted_at IS NULL AND settled_at IS NULL
    RETURNING wakeup_id AS "wakeupId"`;
  // Waiting, or held by a turn just aborted (whose finish would requeue it): never runs.
  const expired = yield* sql`UPDATE kin_events AS e SET state = 'expired'
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND (e.state = 'queued'
      OR (e.state = 'claimed' AND EXISTS (SELECT 1 FROM kin_wakeups w WHERE w.org_id = e.org_id
        AND w.wakeup_id = e.wakeup_id AND w.aborted_at IS NOT NULL)))
    RETURNING event_id`;
  // Stored before anything is interrupted, so nothing of theirs publishes from here on.
  const workers = yield* sql<{ workerId: KinWorkerId }>`SELECT worker_id AS "workerId"
    FROM kin_workers WHERE org_id = ${orgId} AND agent_id = ${agentId} AND ended_at IS NULL
    ORDER BY worker_id`;
  for (const { workerId } of workers)
    yield* stopAttempt({
      orgId,
      agentId,
      workerId,
      reason: RETIRED_WORKER_REASON,
      key: retiredWorkerKey(workerId, input.retiredAt),
      at: now,
    });
  // Kin-clock timers in chats no live agent answers: deferrals, reminders and scheduled runs.
  const chats = heldChats(sql, orgId, agentId);
  yield* sql`INSERT INTO kin_retirement_holds
      (org_id, agent_id, kind, target_id, next_run_at, held_at)
    SELECT t.org_id, ${agentId}, 'trigger', t.trigger_id, t.next_run_at, ${now} FROM kin_triggers t
    WHERE t.org_id = ${orgId} AND t.enabled = 1 AND (
      EXISTS (SELECT 1 FROM kin_deferral_runs r JOIN kin_widgets w ON w.org_id = r.org_id
          AND w.widget_id = 'deferral:' || r.org_id || ':' || r.item_id
        WHERE r.org_id = t.org_id AND t.trigger_id IN ('deferral:' || r.item_id || ':heads_up',
            'deferral:' || r.item_id || ':due')
          AND w.chat_id IN (${chats}))
      OR EXISTS (SELECT 1 FROM kin_scheduled_tasks s JOIN kin_widgets w ON w.org_id = s.org_id
          AND w.widget_id = 'scheduled:' || s.org_id || ':' || s.item_id
        WHERE s.org_id = t.org_id AND t.trigger_id = 'schedule:' || s.item_id
          AND w.chat_id IN (${chats})))
    ON CONFLICT DO NOTHING`;
  yield* sql`UPDATE kin_triggers SET enabled = 0, updated_at = ${now}
    WHERE org_id = ${orgId} AND enabled = 1 AND trigger_id IN (SELECT target_id
      FROM kin_retirement_holds WHERE org_id = ${orgId} AND agent_id = ${agentId}
        AND kind = 'trigger')`;
  // Its native schedules, paused as the card's Pause does; one already paused stays the owner's.
  yield* sql`INSERT INTO kin_retirement_holds (org_id, agent_id, kind, target_id, held_at)
    SELECT s.org_id, s.agent_id, 'schedule', s.task_id, ${now}
    FROM kin_schedules s JOIN scheduled_tasks n ON n.task_id = s.task_id
    WHERE s.org_id = ${orgId} AND s.agent_id = ${agentId} AND s.deleted_at IS NULL
      AND COALESCE(s.pending_enabled, n.enabled) = 1
    ON CONFLICT DO NOTHING`;
  yield* sql`UPDATE kin_schedules SET pending_enabled = 0, updated_at = ${now}
    WHERE org_id = ${orgId} AND task_id IN (SELECT target_id FROM kin_retirement_holds
      WHERE org_id = ${orgId} AND agent_id = ${agentId} AND kind = 'schedule')`;
  // What it asked the owner to approve closes; an approval can't act for a retired agent.
  yield* (yield* KinRetiredActions).close({ orgId, agentId });
  return {
    turns: turns.map((row) => KinWakeupId.make(row.wakeupId)),
    expired: expired.length,
  };
});

/**
 * In the restore's transaction: the timers and schedules retiring paused run again (a due one
 * fires late, once). Stopped workers, expired events and closed requests stay as they are.
 */
export const restore = Effect.fn("KinRetirement.restore")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, now } = input;
  const held = sql`SELECT target_id FROM kin_retirement_holds
    WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  yield* sql`UPDATE kin_triggers AS t SET enabled = 1, updated_at = ${now},
      next_run_at = COALESCE(t.next_run_at, (SELECT h.next_run_at FROM kin_retirement_holds h
        WHERE h.org_id = t.org_id AND h.agent_id = ${agentId} AND h.kind = 'trigger'
          AND h.target_id = t.trigger_id))
    WHERE t.org_id = ${orgId} AND t.enabled = 0 AND t.trigger_id IN (${held} AND kind = 'trigger')`;
  yield* sql`UPDATE kin_schedules SET pending_enabled = 1, updated_at = ${now}
    WHERE org_id = ${orgId} AND deleted_at IS NULL AND COALESCE(pending_enabled, 0) = 0
      AND task_id IN (${held} AND kind = 'schedule')`;
  yield* sql`DELETE FROM kin_retirement_holds WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
});
