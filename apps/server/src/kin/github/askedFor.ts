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
import { headKey, receiptOf } from "./boundReview.ts";

/** The owner's line on a review someone asked for in Kin ends with this (`reviewAsk.ts`). */
const askedForLine = (name: string) => `${name} asked for it.`;

/** A trigger's key as handled for an ask whose turn didn't finish: asking again retries it. */
export const UNFINISHED = "unfinished";

export const postedLine = (ref: string, head: string, url: string) =>
  `Review posted on ${ref} at ${head.slice(0, 7)}: ${url}`;
export const unfinishedLine = (ref: string) =>
  `The review of ${ref} did not finish. Ask again to retry.`;
const unsureLine = (ref: string) =>
  `Kin sent the review of ${ref} and GitHub didn't confirm it, so Kin won't send it again.`;
/** The owner's line on a review of an outsider's pull request: Kin's own, never the model's. */
export const outsideLine = (ref: string, receipt: ReturnType<typeof receiptOf>, pullUrl: string) =>
  receipt._tag === "posted"
    ? `Reviewed ${ref}, opened by someone outside the company: ${receipt.url}`
    : receipt._tag === "unknown"
      ? `Kin sent a review of ${ref}, opened by someone outside the company, and GitHub didn't confirm it: ${pullUrl}`
      : `The review of ${ref}, opened by someone outside the company, did not post: ${pullUrl}`;

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

const notice = Effect.fn("KinGitHubReviewAsk.notice")(function* (
  deps: {
    readonly repo: KinChatRepository["Service"];
    readonly hub: Option.Option<KinChatHub["Service"]>;
  },
  input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly id: string;
    readonly body: string;
    readonly now: string;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const posted = yield* deps.repo
    .insertMessage({
      orgId: input.orgId,
      chatId: input.chatId,
      // Fixed words from Kin's own records.
      audience: "chat",
      messageId: KinMessageId.make(input.id),
      author: { _tag: "system" },
      kind: "system",
      body: input.body,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: input.now,
      editedAt: null,
    })
    .pipe(Effect.option);
  if (Option.isSome(posted) && Option.isSome(deps.hub))
    yield* sql.afterCommit(
      deps.hub.value.publish({ type: "message.posted", orgId: input.orgId, message: posted.value }),
    );
});

/**
 * Run by the queue in the transaction that ends these events, from the receipt each review's post
 * left on its head: a review someone asked for is told in their own chat with the agent, or as not
 * finished, which frees its head for the next ask; one of an outsider's pull request is told in the
 * owner's chat, as the model's own words never are (`replyLane.ts`).
 */
export const settleReviews = Effect.fn("KinGitHubReviewAsk.settle")(function* (
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
    personId: string | null;
    key: string;
    repo: string;
    number: number;
    head: string | null;
    pullUrl: string;
    outside: number;
    ownerChatId: string | null;
  }>`SELECT e.event_id AS "eventId", e.agent_id AS "agentId",
      json_extract(e.json, '$.askedBy') AS "personId",
      json_extract(e.json, '$.trigger.key') AS key, json_extract(e.json, '$.repo') AS repo,
      json_extract(e.json, '$.trigger.number') AS number,
      json_extract(e.json, '$.trigger.pull.headSha') AS head,
      json_extract(e.json, '$.trigger.url') AS "pullUrl",
      (json_extract(e.json, '$.trigger.inside') = 0
        AND json_extract(e.json, '$.trigger.kind') IN ('review', 'review_request')) AS outside,
      l.owner_chat_id AS "ownerChatId"
    FROM kin_events e
    LEFT JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
    WHERE e.org_id = ${orgId} AND e.event_id IN ${sql.in(eventIds)} AND e.tag = 'github'
      AND (json_extract(e.json, '$.askedBy') IS NOT NULL
        OR (json_extract(e.json, '$.trigger.inside') = 0
          AND json_extract(e.json, '$.trigger.kind') IN ('review', 'review_request')))
    ORDER BY e.event_id`;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const event of ended) {
    const ref = `${event.repo}#${event.number}`;
    const key = event.head === null ? event.key : headKey(event.repo, event.number, event.head);
    const [row] = yield* sql<{ url: string | null }>`SELECT review_url AS url
      FROM kin_github_handled WHERE org_id = ${orgId} AND trigger_key = ${key}`;
    const receipt = receiptOf(row?.url ?? null);
    if (event.personId !== null && receipt._tag === "none")
      yield* sql`UPDATE kin_github_handled SET outcome = ${UNFINISHED}
        WHERE org_id = ${orgId} AND trigger_key = ${event.key} AND outcome = 'woke'
          AND review_url IS NULL`;
    if (Option.isNone(deps.repo)) continue;
    const agentId = KinAgentId.make(event.agentId);
    if (event.outside === 1 && event.ownerChatId !== null)
      yield* notice(
        { repo: deps.repo.value, hub: deps.hub },
        {
          orgId,
          chatId: KinChatId.make(event.ownerChatId),
          id: `kin-review-outside:${event.eventId}`,
          body: outsideLine(ref, receipt, event.pullUrl),
          now,
        },
      );
    if (event.personId === null) continue;
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
    // The owner's own chat already has the outside line.
    if (event.outside === 1 && chat.chatId === event.ownerChatId) continue;
    yield* notice(
      { repo: deps.repo.value, hub: deps.hub },
      {
        orgId,
        chatId,
        id: `kin-review-settled:${event.eventId}`,
        body:
          receipt._tag === "posted"
            ? postedLine(ref, event.head ?? "", receipt.url)
            : receipt._tag === "unknown"
              ? unsureLine(ref)
              : unfinishedLine(ref),
        now,
      },
    );
  }
});
