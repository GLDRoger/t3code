import { KinMessageId, KinWidgetId, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { abortPrivateTurns } from "./Audience.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./orgLeads.ts";

/** Chat events that answer a person's message, tap or reaction in its chat. */
const CHAT_EVENT_TAGS = ["chat.message", "widget.action", "chat.reaction"] as const;

/** The fixed line a private worker's card in a shared chat shows instead of its own. */
const movedCardTitle = (lead: string) => `Moved to your private chat with ${lead}`;

/**
 * In the join's transaction, after `recordJoin`: aborts private turns, expires waiting chat
 * events from before `shared_from_seq`, and moves private workers (and their waiting reports) to
 * their lead's owner chat. Idempotent. Returns what the caller finishes after commit.
 */
export const onPersonJoined = Effect.fn("KinChatSharing.onPersonJoined")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly personId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const turns = yield* abortPrivateTurns(input);
  const [chat] = yield* sql<{ sharedFromSeq: number | null }>`
    SELECT shared_from_seq AS "sharedFromSeq" FROM kin_chats
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND shared_at IS NOT NULL
    ORDER BY chat_id`;
  if (chat === undefined || chat.sharedFromSeq === null) return { turns, expired: [], moved: [] };
  // Waiting, or held by a turn this join aborted: no fresh turn answers them where others read.
  const pending = sql`(e.state = 'queued' OR (e.state = 'claimed' AND EXISTS (SELECT 1
    FROM kin_wakeups w WHERE w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
      AND w.aborted_at IS NOT NULL)))`;
  const expired = yield* sql<{ agentId: KinAgentId }>`UPDATE kin_events AS e SET state = 'expired'
    WHERE e.org_id = ${input.orgId} AND e.tag IN ${sql.in(CHAT_EVENT_TAGS)}
      AND json_extract(e.json, '$.chatId') = ${input.chatId} AND ${pending}
      AND EXISTS (SELECT 1 FROM kin_messages m WHERE m.org_id = e.org_id
        AND m.message_id = json_extract(e.json, '$.messageId') AND m.seq < ${chat.sharedFromSeq})
    RETURNING agent_id AS "agentId"`;
  const now = yield* Clock.currentTimeMillis;
  const moved = yield* sql<{ workerId: string; agentId: KinAgentId; threadId: string }>`
    UPDATE kin_workers SET moved_at = ${now}
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND context = 'private'
      AND moved_at IS NULL
    RETURNING worker_id AS "workerId", agent_id AS "agentId", thread_id AS "threadId"`;
  yield* sql`UPDATE kin_events AS e SET json = json_remove(e.json, '$.chatId', '$.origin')
    WHERE e.org_id = ${input.orgId} AND e.tag = 'worker.report'
      AND json_extract(e.json, '$.chatId') = ${input.chatId} AND ${pending}
      AND EXISTS (SELECT 1 FROM kin_workers k WHERE k.org_id = e.org_id
        AND k.worker_id = json_extract(e.json, '$.workerId') AND k.context = 'private')`;
  return { turns, expired, moved };
});

/**
 * Where a worker's report and card go: its own chat, or its lead's owner chat once that chat was
 * shared after an owner-only turn gave it the work (`moved`). From stored rows only.
 */
export const workerChat = Effect.fn("KinChatSharing.workerChat")(function* (input: {
  readonly orgId: KinOrgId;
  readonly workerId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    chatId: string | null;
    ownerChatId: string;
    moved: number;
    leadName: string;
  }>`SELECT k.chat_id AS "chatId", l.owner_chat_id AS "ownerChatId", a.display_name AS "leadName",
      (k.context = 'private' AND c.shared_at IS NOT NULL) AS moved
    FROM kin_workers k JOIN kin_leads l ON l.org_id = k.org_id AND l.agent_id = k.agent_id
    JOIN kin_agents a ON a.org_id = k.org_id AND a.agent_id = k.agent_id
    LEFT JOIN kin_chats c ON c.org_id = k.org_id AND c.chat_id = k.chat_id
    WHERE k.org_id = ${input.orgId} AND k.worker_id = ${input.workerId} ORDER BY k.worker_id`;
  if (row === undefined) return undefined;
  return row.moved === 1
    ? {
        chatId: row.ownerChatId,
        moved: { from: row.chatId, leadName: row.leadName },
      }
    : { chatId: row.chatId, moved: undefined };
});

/**
 * A moved worker's card in the chat it left keeps no words of its own: the fixed line, no model,
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
 * After a chat is shared, its open cards from before stop taking taps there: the owner's reminder,
 * deferral and scheduled-task cards move to the owner chat of the lead they fire with, on a new
 * line there, and the rest close. Approval cards stay with their signed flow; task cards follow
 * their worker (`freezeMovedCard`).
 */
export const settleCards = Effect.fn("KinChatSharing.settleCards")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const [chat] = yield* sql<{ from: number }>`SELECT shared_from_seq AS "from" FROM kin_chats
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND shared_from_seq IS NOT NULL
    ORDER BY chat_id`;
  if (chat === undefined) return;
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
