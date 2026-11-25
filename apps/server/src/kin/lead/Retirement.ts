import {
  type KinAgentId,
  type KinChatId,
  KinMessageId,
  type KinOrgId,
  KinWakeupId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import type { KinChatService } from "../chat/KinChatService.ts";
import { closeRetiredTroubles } from "../host/KinHostCare.ts";
import {
  closeHeldQuestions,
  reopenRetiredQuestions,
  retiredQuestionText,
} from "../questions/openQuestions.ts";
import * as KinWatches from "../watches/KinWatches.ts";

/**
 * What retiring an agent does to everything it has in flight, inside the transaction that sets
 * `retired_at`, and what restoring it undoes. Its chats, history, memory and Work entries stay.
 */

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
export const retire = Effect.fn("KinRetirement.retire")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly retiredAt: string;
    readonly now: number;
  },
  chat: Pick<KinChatService["Service"], "closeReplaced" | "notice">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, now } = input;
  // Every turn it ever began, whatever its state (a join may have aborted one already): the mark
  // outlives a restore, so what such a turn sent meanwhile still starts stopped.
  yield* sql`UPDATE kin_wakeups SET retired_at = ${now}
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND retired_at IS NULL`;
  // Its turns under way, as a join aborts one: nothing more lands anywhere, memory is discarded.
  const turns = yield* sql<{ wakeupId: string }>`
    UPDATE kin_wakeups SET aborted_at = ${now},
      shared_since = COALESCE(shared_since, ${now})
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND status = 'running'
      AND aborted_at IS NULL AND settled_at IS NULL
    RETURNING wakeup_id AS "wakeupId"`;
  // Waiting, or held by a turn just aborted (whose finish would requeue it): never runs.
  const expired = yield* sql`UPDATE kin_events AS e SET state = 'expired'
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND (e.state IN ('queued', 'failed')
      OR (e.state = 'claimed' AND EXISTS (SELECT 1 FROM kin_wakeups w WHERE w.org_id = e.org_id
        AND w.wakeup_id = e.wakeup_id AND w.aborted_at IS NOT NULL)))
    RETURNING event_id`;
  // Someone whose message in their direct chat now goes unanswered hears why, once per chat.
  const ids = expired.map((row) => String(row.event_id));
  const unanswered =
    ids.length === 0
      ? []
      : yield* sql<{ chatId: KinChatId; messageId: KinMessageId; name: string }>`
          SELECT m.chat_id AS "chatId", MAX(m.message_id) AS "messageId",
            COALESCE(l.name, a.display_name) AS name
          FROM kin_events e
          JOIN kin_messages m ON m.org_id = e.org_id AND m.author_kind = 'human'
            AND m.message_id = json_extract(e.json, '$.messageId')
          JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id AND c.kind = 'direct'
          JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
          LEFT JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
          WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.tag = 'chat.message'
            AND e.event_id IN ${sql.in(ids)}
          GROUP BY m.chat_id ORDER BY m.chat_id`;
  for (const row of unanswered)
    yield* chat.notice({
      orgId,
      chatId: row.chatId,
      messageId: retiredNoticeId(row.messageId),
      audience: "chat",
      body: retiredAgentNotice(row.name),
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
  // Its questions close at the retirement's instant, which is how a restore finds them.
  yield* closeHeldQuestions(
    {
      orgId,
      holder: { agentId },
      reason: (row) => retiredQuestionText(row.agentName),
      closedAt: now,
    },
    chat,
  );
  yield* KinWatches.closeRetired(orgId, agentId, now);
  yield* closeRetiredTroubles(orgId, agentId, now);
  return {
    turns: turns.map((row) => KinWakeupId.make(row.wakeupId)),
    expired: expired.length,
  };
});

/**
 * In the restore's transaction: the timers and schedules retiring paused run again (a due one
 * fires late, once; a scheduled run more than two hours late is skipped instead), and the
 * questions retiring closed reopen. Expired events and closed requests stay as they are.
 */
export const restore = Effect.fn("KinRetirement.restore")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  /** The `retired_at` being undone. */
  readonly retiredAt: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, now } = input;
  const retiredAt = Date.parse(input.retiredAt);
  yield* reopenRetiredQuestions({ orgId, agentId, retiredAt, now });
  yield* KinWatches.reopenRetired(orgId, agentId, retiredAt, now);
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
