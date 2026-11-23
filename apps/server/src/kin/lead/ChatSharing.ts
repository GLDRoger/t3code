import {
  KinMessageId,
  KinWidgetId,
  ThreadId,
  type KinAgentId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { historyFloor } from "../chat/sharing.ts";
import { abortChatTurns } from "./Audience.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./orgLeads.ts";

/** Chat events that answer a person's message, tap or reaction in its chat. */
const CHAT_EVENT_TAGS = ["chat.message", "widget.action", "chat.reaction"] as const;

/** The fixed line a delegated task's card in a shared chat shows instead of its own. */
const movedCardTitle = (lead: string) => `Moved to your private chat with ${lead}`;

/**
 * Ends the lead threads of chats matching `where`, in the caller's transaction, so no turn after it
 * resumes a model context from before. Returns them for `KinIdentity.endAgentThread` after commit.
 */
const endChatThreads = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  where: Statement.Fragment,
) {
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const rows = yield* sql<{ threadId: string }>`UPDATE kin_agent_threads SET ended_at = ${at}
    WHERE org_id = ${orgId} AND ended_at IS NULL AND chat_id IS NOT NULL AND ${where}
    RETURNING thread_id AS "threadId"`;
  return rows.map((row) => ThreadId.make(row.threadId));
});

/**
 * In every join's transaction, after `recordJoin`: aborts the running turns there and ends the
 * chat's lead threads; expires waiting events below the history floor; names the tasks agents
 * delegated there, whose cards the caller freezes, as only owner-only turns delegate. Returns what
 * runs after commit.
 */
export const onPersonJoined = Effect.fn("KinChatSharing.onPersonJoined")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly personId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const turns = yield* abortChatTurns(input);
  const threads = yield* endChatThreads(sql, input.orgId, sql`chat_id = ${input.chatId}`);
  const [chat] = yield* sql<{ floor: number | null }>`
    SELECT ${historyFloor(sql, input.orgId, input.chatId)} AS floor`;
  const moved = yield* sql<{ threadId: string; leadName: string }>`
    SELECT DISTINCT json_extract(w.state_json, '$.threadId') AS "threadId",
      a.display_name AS "leadName"
    FROM kin_widgets w JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
    JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.author_agent_id
    WHERE w.org_id = ${input.orgId} AND w.chat_id = ${input.chatId} AND w.type = 'task'
      AND json_extract(w.state_json, '$.threadId') IS NOT NULL
    ORDER BY 1`;
  if (chat === undefined || chat.floor === null) return { turns, threads, expired: [], moved };
  // Waiting, or held by a turn this join aborted: no fresh turn answers them where others read.
  const pending = sql`(e.state = 'queued' OR (e.state = 'claimed' AND EXISTS (SELECT 1
    FROM kin_wakeups w WHERE w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
      AND w.aborted_at IS NOT NULL)))`;
  const expired = yield* sql<{ agentId: KinAgentId }>`UPDATE kin_events AS e SET state = 'expired'
    WHERE e.org_id = ${input.orgId} AND e.tag IN ${sql.in(CHAT_EVENT_TAGS)}
      AND json_extract(e.json, '$.chatId') = ${input.chatId} AND ${pending}
      AND EXISTS (SELECT 1 FROM kin_messages m WHERE m.org_id = e.org_id
        AND m.message_id = json_extract(e.json, '$.messageId') AND m.seq < ${chat.floor})
    RETURNING agent_id AS "agentId"`;
  return { turns, threads, expired, moved };
});

/**
 * In the transaction that removes `personId` from the org: every event that is theirs (their
 * message, tap or reaction, work done for them, anything in their direct chats) expires, turns
 * holding one abort, and those chats' lead threads end. Returns what the caller runs after commit.
 */
export const onPersonRemoved = Effect.fn("KinChatSharing.onPersonRemoved")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const theirs = sql`(
    (json_extract(e.json, '$.provenance._tag') = 'human'
      AND json_extract(e.json, '$.provenance.personId') = ${input.personId})
    OR json_extract(e.json, '$.origin.personId') = ${input.personId}
    OR (e.tag = 'github' AND json_extract(e.json, '$.askedBy') = ${input.personId})
    OR EXISTS (SELECT 1 FROM kin_messages m WHERE m.org_id = e.org_id
      AND e.tag IN ('chat.message', 'widget.action')
      AND m.message_id = json_extract(e.json, '$.messageId') AND m.author_kind = 'human'
      AND m.author_person_id = ${input.personId})
    OR EXISTS (SELECT 1 FROM kin_chats c JOIN kin_chat_members cm ON cm.org_id = c.org_id
      AND cm.chat_id = c.chat_id
      WHERE c.org_id = e.org_id AND c.kind = 'direct' AND cm.principal_kind = 'person'
        AND cm.person_id = ${input.personId} AND c.chat_id = json_extract(e.json, '$.chatId')))`;
  const turns = yield* sql<{ agentId: KinAgentId; wakeupId: string }>`
    UPDATE kin_wakeups AS w SET aborted_at = ${now}, shared_since = COALESCE(shared_since, ${now})
    WHERE w.org_id = ${input.orgId} AND w.status = 'running' AND w.aborted_at IS NULL
      AND w.settled_at IS NULL
      AND EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = w.org_id
        AND e.agent_id = w.agent_id AND e.wakeup_id = w.wakeup_id AND ${theirs})
    RETURNING agent_id AS "agentId", wakeup_id AS "wakeupId"`;
  // Claimed by a turn just aborted, too: its finish requeues what it held, and these never run.
  const expired = yield* sql<{ agentId: KinAgentId; heldBy: string | null }>`
    UPDATE kin_events AS e SET state = 'expired'
    WHERE e.org_id = ${input.orgId} AND ${theirs} AND (e.state IN ('queued', 'failed')
      OR (e.state = 'claimed' AND EXISTS (SELECT 1 FROM kin_wakeups w
        WHERE w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id AND w.aborted_at IS NOT NULL)))
    RETURNING agent_id AS "agentId", held_by AS "heldBy"`;
  const threads = yield* endChatThreads(
    sql,
    input.orgId,
    sql`chat_id IN (SELECT c.chat_id FROM kin_chats c JOIN kin_chat_members cm
      ON cm.org_id = c.org_id AND cm.chat_id = c.chat_id
      WHERE c.org_id = ${input.orgId} AND c.kind = 'direct' AND cm.principal_kind = 'person'
        AND cm.person_id = ${input.personId})`,
  );
  return { turns, threads, expired };
});

/**
 * A moved task's card in the chat it left keeps no words of its own: the fixed line, no model,
 * pull request or error, and closed, so nothing updates it there again.
 */
export const freezeMovedCard = Effect.fn("KinChatSharing.freezeMovedCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly threadId: string;
  readonly leadName: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const title = movedCardTitle(input.leadName);
  const rows = yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId" FROM kin_widgets
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND type = 'task'
      AND json_extract(state_json, '$.threadId') = ${input.threadId}
      AND (closed_at IS NULL OR json_extract(state_json, '$.title') IS NOT ${title})
    ORDER BY widget_id`;
  for (const row of rows) {
    const found = yield* repo.getWidget({
      orgId: input.orgId,
      widgetId: KinWidgetId.make(row.widgetId),
    });
    if (Option.isNone(found)) continue;
    const widget = found.value;
    const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const state = typeof widget.state === "object" && widget.state !== null ? widget.state : {};
    const frozen = yield* repo.updateWidget({
      ...widget,
      // The fixed line replaces the card's own words.
      audience: "chat",
      state: { ...state, title, model: null, pullRequests: [], lastError: null, updatedAt: at },
      awaiting: [],
      expectedRevision: widget.revision,
      closedAt: widget.closedAt ?? at,
      updatedAt: at,
    });
    yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget: frozen });
  }
});

/** Cards of reminders, deferrals and scheduled tasks: only owner-only turns set those up. */
const OWNER_CARDS = ["deferral", "reminder", "scheduled_task"];

/**
 * After a join, the chat's open cards from below its history floor stop taking taps there: the
 * owner's reminder, deferral and scheduled-task cards move to the owner chat of the lead they fire
 * with, on a new line there, and the rest close. Approval cards stay with their signed flow; task
 * cards freeze and follow their task (`freezeMovedCard`).
 */
export const settleCards = Effect.fn("KinChatSharing.settleCards")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const [chat] = yield* sql<{ from: number | null }>`
    SELECT ${historyFloor(sql, input.orgId, input.chatId)} AS "from"`;
  if (chat === undefined || chat.from === null) return;
  const rows = yield* sql<{ widgetId: string; type: string; body: string }>`
    SELECT w.widget_id AS "widgetId", w.type, m.body FROM kin_widgets w
    JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
    WHERE w.org_id = ${input.orgId} AND w.chat_id = ${input.chatId} AND w.closed_at IS NULL
      AND m.seq < ${chat.from} AND w.type NOT IN ('approval', 'task')
    ORDER BY m.seq, w.widget_id`;
  if (rows.length === 0) return;
  const lead = yield* liveLead(sql, input.orgId, {
    chatId: input.chatId,
    prefer: CHIEF_OF_STAFF_DOMAIN,
  });
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  for (const row of rows) {
    const widgetId = KinWidgetId.make(row.widgetId);
    const found = yield* repo.getWidget({ orgId: input.orgId, widgetId });
    if (Option.isNone(found)) continue;
    const widget = found.value;
    if (lead !== undefined && OWNER_CARDS.includes(row.type)) {
      const line = yield* repo.insertMessage({
        orgId: input.orgId,
        chatId: lead.ownerChatId,
        audience: "owner",
        messageId: KinMessageId.make(`${row.widgetId}:moved`),
        author: { _tag: "system" },
        kind: "system",
        body: row.body,
        intent: null,
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: null,
        createdAt: at,
        editedAt: null,
      });
      yield* sql`UPDATE kin_widgets SET chat_id = ${lead.ownerChatId}, message_id = ${line.messageId}
        WHERE org_id = ${input.orgId} AND widget_id = ${widgetId}`;
      yield* sql`UPDATE kin_waiting SET chat_id = ${lead.ownerChatId}
        WHERE org_id = ${input.orgId} AND widget_id = ${widgetId} AND resolved_at IS NULL`;
      const moved = yield* repo.getWidget({ orgId: input.orgId, widgetId });
      yield* hub.publish({ type: "message.posted", orgId: input.orgId, message: line });
      if (Option.isSome(moved))
        yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget: moved.value });
      continue;
    }
    const closed = yield* repo.updateWidget({
      ...widget,
      // Closing writes no words.
      audience: "chat",
      awaiting: [],
      expectedRevision: widget.revision,
      closedAt: at,
      updatedAt: at,
    });
    for (const item of yield* repo.waitingForWidget(closed))
      if (yield* repo.resolveWaiting({ ...item, resolution: "closed", resolvedAt: at })) {
        const resolved = yield* repo.getWaiting(item);
        if (Option.isSome(resolved))
          yield* hub.publish({ type: "waiting.updated", orgId: input.orgId, item: resolved.value });
      }
    yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget: closed });
  }
});
