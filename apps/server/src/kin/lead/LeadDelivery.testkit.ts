import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Stands in for the lead's wake-up for one queued event: it claims the event, posts `body` in
 * the lane as the lead when given, and ends `completed` or `failed`. Returns the message id.
 */
export const leadWakeup = Effect.fn("test.leadWakeup")(function* (input: {
  readonly orgId: KinOrgId;
  readonly eventId: string;
  readonly chatId: string;
  readonly body?: string;
  readonly status?: "completed" | "failed";
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const status = input.status ?? "completed";
  const wakeupId = `wakeup-${input.eventId}`;
  const [lead] = yield* sql<{ agentId: string; ownerPersonId: string; memberId: string }>`
    SELECT e.agent_id AS "agentId", a.owner_person_id AS "ownerPersonId", m.member_id AS "memberId"
    FROM kin_events e
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    JOIN kin_chat_members m ON m.org_id = e.org_id AND m.chat_id = ${input.chatId}
      AND m.principal_kind = 'agent' AND m.agent_id = e.agent_id
    WHERE e.org_id = ${input.orgId} AND e.event_id = ${input.eventId} ORDER BY e.event_id`;
  if (lead === undefined) return yield* Effect.die("no queued event for that lead and chat");
  yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, ended_at,
      status, event_ids)
    VALUES (${input.orgId}, ${wakeupId}, ${lead.agentId}, 'fixture', ${now}, ${now + 2_000},
      ${status}, '[]')`;
  yield* sql`UPDATE kin_events SET state = ${status === "completed" ? "done" : "failed"},
      wakeup_id = ${wakeupId}
    WHERE org_id = ${input.orgId} AND event_id = ${input.eventId}`;
  if (input.body === undefined) return null;
  const messageId = `lead-message-${input.eventId}`;
  const [chat] = yield* sql<{ seq: number }>`UPDATE kin_chats SET last_seq = last_seq + 1
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} RETURNING last_seq AS seq`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
      author_agent_id, author_owner_person_id, author_thread_id, author_member_id, author_role,
      kind, body, intent, mentions_json, status, created_at)
    VALUES (${messageId}, ${input.orgId}, ${input.chatId}, ${chat?.seq ?? 1}, 'agent',
      ${lead.agentId}, ${lead.ownerPersonId}, 'thread-fixture', ${lead.memberId}, 'member',
      'text', ${input.body}, 'evidence', '[]', 'posted', ${iso(now + 1_000)})`;
  return messageId;
});
