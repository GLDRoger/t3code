import {
  KIN_WORKER_PUBLISH_CARD,
  KIN_WORKER_PUBLISH_CARD_ACTIONS,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinWidgetId,
  KinWorkerPublishCard,
  type KinOrgId,
  type KinWidget,
  type KinWorkerPublishCardAction,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import * as Attempts from "../work/workerAttempts.ts";

/**
 * The owner's card for a finished worker's commit that Kin holds instead of publishing: one per
 * commit and title of an attempt, in the owner's direct chat with the lead, written for the owner
 * alone. Only the owner's tap on it publishes; its facts come from Kin's own git and GitHub.
 */

/** A card's fixed words: what older clients show, and the only words its push carries. */
export const WORKER_PUBLISH_TEXT =
  "Kin is holding a worker's changes until you choose to publish them. If this chat shows no Publish button, open it in Kin on the web.";

const decodeCard = Schema.decodeUnknownEffect(KinWorkerPublishCard);
/** The publisher's file list as `recordReview` stores it. */
export const ReviewedFiles = Schema.Struct({
  files: KinWorkerPublishCard.fields.files,
  moreFiles: Schema.Number,
});
const decodeFiles = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewedFiles));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isAction = (actionId: string): actionId is KinWorkerPublishCardAction =>
  KIN_WORKER_PUBLISH_CARD_ACTIONS.some((action) => action === actionId);

/** FNV-1a over the title: an id part, not a secret, so any stable spread will do. */
const titleHash = (title: string) => {
  let hash = 0x811c9dc5;
  for (const char of title) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/** One card per commit and title of an attempt, so another of either is a new card. */
const publishCardId = (attempt: Attempts.Attempt, sha: string, title: string) =>
  KinWidgetId.make(
    `kin-publish:${attempt.workerId}:${attempt.startedAt}:${sha.slice(0, 16)}:${titleHash(title)}`,
  );

/**
 * In the hold's transaction: the card for what the attempt now holds, unless it is already there,
 * and the one it replaces closed. Nothing is written into a chat anyone but the owner reads.
 */
export const writePublishCard = Effect.fn("KinWorkerPublishCard.write")(function* (input: {
  readonly attempt: Attempts.Attempt;
  readonly row: Attempts.AttemptRow;
  readonly reasons: ReadonlyArray<Attempts.GateReason>;
  readonly previousCardId: string | null;
  readonly repository: string;
  readonly branch: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const { attempt, row } = input;
  if (row.readySha === null || row.readyTitle === null) return;
  const [owner] = yield* sql<{ chatId: string; personId: string }>`
    SELECT l.owner_chat_id AS "chatId", a.owner_person_id AS "personId" FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id AND c.kind = 'direct'
    WHERE l.org_id = ${attempt.orgId} AND l.agent_id = ${row.agentId} ORDER BY l.agent_id`;
  if (owner === undefined) return yield* Effect.logWarning("Kin publish card has no owner chat");
  if (input.previousCardId !== null)
    yield* settlePublishCard(attempt.orgId, input.previousCardId, "replaced");
  const widgetId = publishCardId(attempt, row.readySha, row.readyTitle);
  if (Option.isSome(yield* repo.getWidget({ orgId: attempt.orgId, widgetId }))) {
    yield* Attempts.readyCard(attempt, widgetId);
    return;
  }
  const reviewed =
    row.reviewedSha === row.readySha ? decodeFiles(row.filesJson ?? "") : Option.none();
  const listed = Option.getOrElse(reviewed, () => ({ files: [], moreFiles: 0 }));
  const state: KinWorkerPublishCard = {
    text: WORKER_PUBLISH_TEXT,
    workerId: attempt.workerId,
    sha: row.readySha,
    repository: input.repository,
    why: [...input.reasons],
    branch: input.branch,
    pullRequestTitle: row.readyTitle,
    files: listed.files,
    moreFiles: listed.moreFiles,
    status: "waiting",
  };
  const at = iso(yield* Clock.currentTimeMillis);
  const chatId = KinChatId.make(owner.chatId);
  const message = yield* repo.insertMessage({
    orgId: attempt.orgId,
    chatId,
    audience: "owner",
    messageId: KinMessageId.make(widgetId),
    author: { _tag: "system" },
    kind: "system",
    body: WORKER_PUBLISH_TEXT,
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
  const widget = {
    orgId: attempt.orgId,
    chatId,
    messageId: message.messageId,
    widgetId,
    widgetClass: "native" as const,
    type: KIN_WORKER_PUBLISH_CARD,
    state,
    source: null,
    feed: null,
    // Waiting on the owner: its push says only that a card waits, never what it holds.
    awaiting: [KinPersonId.make(owner.personId)],
    pinnedAt: null,
    closedAt: null,
    updatedAt: at,
  };
  yield* repo.insertWidget({ ...widget, audience: "owner" });
  yield* Attempts.readyCard(attempt, widgetId);
  yield* sql.afterCommit(
    hub.publish({
      type: "message.posted",
      orgId: attempt.orgId,
      message: { ...message, widgetId },
    }),
  );
  yield* sql.afterCommit(
    hub.publish({
      type: "widget.updated",
      orgId: attempt.orgId,
      widget: { ...widget, revision: 1 },
    }),
  );
});

export type PublishCardEnd = Exclude<KinWorkerPublishCard["status"], "waiting">;

/** A card's next status, closed unless it is still publishing. A settled card stays settled. */
export const settlePublishCard = Effect.fn("KinWorkerPublishCard.settle")(function* (
  orgId: KinOrgId,
  cardId: string,
  status: PublishCardEnd,
  pullRequestUrl?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(cardId) });
  if (Option.isNone(found) || found.value.closedAt !== null) return;
  const card = yield* decodeCard(found.value.state);
  const at = iso(yield* Clock.currentTimeMillis);
  const widget = yield* repo.updateWidget({
    ...found.value,
    audience: "owner",
    state: {
      ...card,
      status,
      ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
    } satisfies KinWorkerPublishCard,
    awaiting: [],
    expectedRevision: found.value.revision,
    closedAt: status === "publishing" ? null : at,
    updatedAt: at,
  });
  yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
});

const LABELS: Record<KinWorkerPublishCardAction, string> = {
  publish: "Publish",
  dont_publish: "Don't publish",
};

/** What a tap says; the server finishes it, so it never wakes the lead. */
export const describePublishTap = Effect.fn("KinWorkerPublishCard.describe")(function* (
  widget: KinWidget,
  actionId: string,
  value: unknown,
) {
  const card = yield* decodeCard(widget.state).pipe(
    Effect.mapError(() => invalid("Invalid widget state.")),
  );
  if (!isAction(actionId) || value !== card.sha) return yield* invalid("Unknown card action.");
  return { card, action: actionId, text: `Tapped "${LABELS[actionId]}"`, wake: false };
});

/**
 * In the tap's transaction, for the person the server authenticated: the owner's decision on the
 * commit and title this card shows, bound to the attempt that holds them. Returns the card's next
 * state. Nothing here publishes; the attempt's follower does, through `beginWrite`.
 */
export const applyPublishTap = Effect.fn("KinWorkerPublishCard.apply")(function* (
  widget: KinWidget,
  tap: Effect.Success<ReturnType<typeof describePublishTap>>,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const attempt = yield* Attempts.attemptOfCard(widget.orgId, widget.widgetId);
  if (attempt === undefined) return yield* invalid("This card is out of date.");
  // The lead's own owner: no teammate, and no one but the person who owns the lead.
  const [owner] = yield* sql<{ personId: string }>`SELECT a.owner_person_id AS "personId"
    FROM kin_worker_attempts w JOIN kin_agents a ON a.org_id = w.org_id AND a.agent_id = w.agent_id
    JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE w.org_id = ${attempt.orgId} AND w.worker_id = ${attempt.workerId}
      AND w.started_at = ${attempt.startedAt} AND l.owner_chat_id = ${widget.chatId}`;
  if (owner === undefined || owner.personId !== personId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner publishes this.",
    });
  const decided = yield* Attempts.decide(attempt, {
    cardId: widget.widgetId,
    sha: tap.card.sha,
    title: tap.card.pullRequestTitle,
    publish: tap.action === "publish",
    personId,
  });
  if (decided._tag !== "decided")
    return {
      state: {
        ...tap.card,
        status: decided._tag === "stopped" ? "stopped" : "replaced",
      } satisfies KinWorkerPublishCard,
      closed: true,
      attempt,
      decided: false,
    };
  return {
    state: {
      ...tap.card,
      status: tap.action === "publish" ? "publishing" : "declined",
    } satisfies KinWorkerPublishCard,
    closed: tap.action !== "publish",
    attempt,
    decided: true,
  };
});
