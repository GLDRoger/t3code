import {
  KinAgentId,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { KinChatHub } from "../chat/KinChatHub.ts";
import type { KinChatRepository } from "../chat/KinChatRepository.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import { directKey } from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";

/** The owner's line on a review someone asked for in Kin ends with this (`reviewAsk.ts`). */
const askedForLine = (name: string) => `${name} asked for it.`;

/** A trigger's key as handled for an ask whose turn didn't finish: asking again retries it. */
export const UNFINISHED = "unfinished";

export const postedLine = (ref: string, head: string, url: string) =>
  `Review posted on ${ref} at ${head.slice(0, 7)}: ${url}`;
export const unfinishedLine = (ref: string) =>
  `The review of ${ref} did not finish. Ask again to retry.`;

/** The name a turn's asked review ends its owner line with, when one of its events carries it. */
export const askedForSuffix = Effect.fn("KinGitHubReviewAsk.askedFor")(function* (
  orgId: KinOrgId,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  // Not when the agent's owner asked: the line is in his own chat.
  const [person] = yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_events e
    JOIN kin_people p ON p.org_id = e.org_id AND p.person_id = json_extract(e.json, '$.askedBy')
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    WHERE e.org_id = ${orgId} AND e.wakeup_id = ${wakeupId} AND e.tag = 'github'
      AND a.owner_person_id <> p.person_id
    ORDER BY e.event_id LIMIT 1`;
  return person === undefined ? undefined : askedForLine(person.name);
});

/**
 * Run by the queue in the transaction that ends these events: each review someone asked for is
 * told in their own chat with the agent, from the receipt its post left, or as not finished,
 * which frees its head for the next ask. Only where an agent's own line could land there now.
 */
export const settleAskedReviews = Effect.fn("KinGitHubReviewAsk.settle")(function* (
  deps: {
    readonly repo: Option.Option<KinChatRepository["Service"]>;
    readonly hub: Option.Option<KinChatHub["Service"]>;
  },
  orgId: KinOrgId,
  eventIds: ReadonlyArray<string>,
) {
  if (eventIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const ended = yield* sql<{
    eventId: string;
    agentId: string;
    personId: string;
    key: string;
    ref: string;
    head: string | null;
    url: string | null;
  }>`SELECT e.event_id AS "eventId", e.agent_id AS "agentId",
      json_extract(e.json, '$.askedBy') AS "personId",
      json_extract(e.json, '$.trigger.key') AS key,
      json_extract(e.json, '$.repo') || '#' || json_extract(e.json, '$.trigger.number') AS ref,
      json_extract(e.json, '$.trigger.pull.headSha') AS head, h.review_url AS url
    FROM kin_events e
    LEFT JOIN kin_github_handled h ON h.org_id = e.org_id
      AND h.trigger_key = json_extract(e.json, '$.trigger.key')
    WHERE e.org_id = ${orgId} AND e.event_id IN ${sql.in(eventIds)} AND e.tag = 'github'
      AND json_extract(e.json, '$.askedBy') IS NOT NULL
    ORDER BY e.event_id`;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const event of ended) {
    if (event.url === null)
      yield* sql`UPDATE kin_github_handled SET outcome = ${UNFINISHED}
        WHERE org_id = ${orgId} AND trigger_key = ${event.key} AND outcome = 'woke'
          AND review_url IS NULL`;
    if (Option.isNone(deps.repo)) continue;
    const agentId = KinAgentId.make(event.agentId);
    const personId = KinPersonId.make(event.personId);
    // Their direct chat, both still in it and the agent not muted there.
    const [chat] = yield* sql<{ chatId: string; ownerChat: number }>`SELECT c.chat_id AS "chatId",
        c.chat_id = l.owner_chat_id AS "ownerChat"
      FROM kin_chats c JOIN kin_leads l ON l.org_id = c.org_id AND l.agent_id = ${agentId}
      WHERE c.org_id = ${orgId} AND c.kind = 'direct' AND c.archived_at IS NULL
        AND c.direct_key = ${directKey(personId, agentId)}
        AND EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id
          AND m.chat_id = c.chat_id AND m.principal_kind = 'person' AND m.person_id = ${personId}
          AND m.left_at IS NULL)
        AND EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id
          AND m.chat_id = c.chat_id AND m.principal_kind = 'agent' AND m.agent_id = ${agentId}
          AND m.left_at IS NULL AND (m.muted_until IS NULL OR m.muted_until <= ${now}))
      ORDER BY c.chat_id LIMIT 1`;
    if (chat === undefined) continue;
    if (!(yield* Reach.reaches(orgId, Reach.person(personId), Reach.agent(agentId)))) continue;
    const chatId = KinChatId.make(chat.chatId);
    if (
      chat.ownerChat !== 1 &&
      !KinLevels.atLeast(yield* KinLevels.effectiveLevel({ orgId, agentId, chatId }), "L1")
    )
      continue;
    const notice = yield* deps.repo.value
      .insertMessage({
        orgId,
        chatId,
        // Fixed words from Kin's own records, about their own request, in their own chat.
        audience: "chat",
        messageId: KinMessageId.make(`kin-review-settled:${event.eventId}`),
        author: { _tag: "system" },
        kind: "system",
        body:
          event.url === null
            ? unfinishedLine(event.ref)
            : postedLine(event.ref, event.head ?? "", event.url),
        intent: null,
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: null,
        createdAt: now,
        editedAt: null,
      })
      .pipe(Effect.option);
    if (Option.isSome(notice) && Option.isSome(deps.hub))
      yield* sql.afterCommit(
        deps.hub.value.publish({ type: "message.posted", orgId, message: notice.value }),
      );
  }
});
