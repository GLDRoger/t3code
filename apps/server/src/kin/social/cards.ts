import {
  KIN_SOCIAL_PACK_CARD,
  KIN_SOCIAL_PACK_CARD_ACTIONS,
  KIN_SOCIAL_WEEK_CARD,
  KIN_SOCIAL_WEEK_CARD_ACTIONS,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinSocialPackCard,
  KinSocialWeekCard,
  KinWidgetId,
  type KinAgentId,
  type KinOrgId,
  type KinSocialCardPost,
  type KinSocialMedia,
  type KinSocialPackCardAction,
  type KinSocialWeekCardAction,
  type KinWidget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { ownerZone } from "../work/recordRows.ts";
import {
  accountsOf,
  CONFIRM_LEAD_MS,
  digestOf,
  mediaOf,
  ownerLevelGroup,
  postById,
  postsOfCard,
  UNDO_CLOSES_MS,
  whenLabel,
  type GroupRow,
  type PostRow,
} from "./rows.ts";

/**
 * The owner's cards for Social: one per group a week, built from Kin's stored drafts and the
 * service's own account names, never from an agent's words; and a ready-to-post pack for what
 * Kin can't post itself. Taps run here, in the tap's transaction; the scheduler does the calls.
 */

/** What older clients show, and the only words a push carries. */
const WEEK_TEXT = "Social has posts for you to look at. Open Kin to confirm them.";
const PACK_TEXT = "Social made a ready-to-post pack. Open Kin to copy it.";

const decodeWeek = Schema.decodeUnknownEffect(KinSocialWeekCard);
const decodePack = Schema.decodeUnknownEffect(KinSocialPackCard);
export const readWeek = Schema.decodeUnknownOption(KinSocialWeekCard);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

const isWeekAction = (actionId: string): actionId is KinSocialWeekCardAction =>
  KIN_SOCIAL_WEEK_CARD_ACTIONS.some((action) => action === actionId);
const isPackAction = (actionId: string): actionId is KinSocialPackCardAction =>
  KIN_SOCIAL_PACK_CARD_ACTIONS.some((action) => action === actionId);

/** The owner's direct chat with this agent: where its cards go, read by the owner alone. */
const ownerChatOf = Effect.fn("KinSocialCards.ownerChat")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId | string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ chatId: string; personId: string }>`
    SELECT l.owner_chat_id AS "chatId", a.owner_person_id AS "personId" FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id AND c.kind = 'direct'
    WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId} ORDER BY l.agent_id`;
  return row;
});

/** One post as the card shows it: the account as the service named it, the time in his zone. */
const cardPost = (
  post: PostRow,
  group: GroupRow | undefined,
  zone: string,
  now: number,
): KinSocialCardPost | undefined => {
  const account =
    group === undefined
      ? undefined
      : accountsOf(group).find((one) => one.accountId === post.accountId);
  if (account === undefined) return undefined;
  const state =
    post.state === "draft" || post.state === "discarded" || post.state === "ready"
      ? "removed"
      : post.state;
  const undoable =
    (state === "scheduled" || state === "scheduling") && post.atMs - UNDO_CLOSES_MS > now;
  return {
    postId: post.postId,
    account,
    caption: post.caption,
    media: mediaOf(post),
    at: iso(post.atMs),
    when: whenLabel(post.atMs, zone),
    state,
    url: post.url,
    reason:
      post.reason ??
      ((state === "scheduled" || state === "scheduling") && !undoable
        ? "It goes out in a few minutes; Undo has closed."
        : null),
    undoUntil: undoable ? iso(post.atMs - UNDO_CLOSES_MS) : null,
  };
};

/** The card's state, as the stored rows and the group say it is now. */
const weekState = Effect.fn("KinSocialCards.weekState")(function* (
  orgId: KinOrgId,
  cardId: string,
  previous: Pick<
    KinSocialWeekCard,
    "groupId" | "group" | "title" | "confirmedAt" | "client" | "replaced"
  >,
) {
  const now = yield* Clock.currentTimeMillis;
  const zone = yield* ownerZone(orgId);
  const group = yield* ownerLevelGroup(orgId, previous.groupId);
  const rows = yield* postsOfCard(orgId, cardId);
  const posts = rows.flatMap((row) => cardPost(row, group, zone, now) ?? []);
  const proposed = rows.filter((row) => row.state === "proposed");
  return {
    text: WEEK_TEXT,
    groupId: previous.groupId,
    group: previous.group,
    title: previous.title,
    posts,
    digest: previous.confirmedAt !== null || proposed.length === 0 ? null : digestOf(proposed),
    confirmedAt: previous.confirmedAt,
    clientReview: previous.clientReview,
    replaced: previous.replaced,
  } satisfies KinSocialWeekCard;
});

/** Rebuilds a card from its rows and tells open screens; a closed card stays as it was. */
export const refreshWeekCard = Effect.fn("KinSocialCards.refresh")(function* (
  orgId: KinOrgId,
  cardId: string,
  change: (card: KinSocialWeekCard) => KinSocialWeekCard = (card) => card,
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(cardId) });
  if (Option.isNone(found)) return;
  const card = change(yield* decodeWeek(found.value.state));
  const state = yield* weekState(orgId, cardId, card);
  const done = state.posts.every((post) => ["removed", "cancelled", "posted"].includes(post.state));
  const at = iso(yield* Clock.currentTimeMillis);
  const widget = yield* repo.updateWidget({
    ...found.value,
    audience: "owner",
    state,
    awaiting: state.digest === null || state.replaced ? [] : found.value.awaiting,
    expectedRevision: found.value.revision,
    closedAt: state.replaced || (done && state.confirmedAt !== null) ? at : null,
    updatedAt: at,
  });
  yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
});

/**
 * In one transaction: the group's next card in the owner's chat with the agent, its drafts on it
 * as proposed, and the group's older open card closed as replaced.
 */
export const writeWeekCard = Effect.fn("KinSocialCards.writeWeek")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly group: GroupRow;
  readonly drafts: ReadonlyArray<PostRow>;
  readonly title: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const owner = yield* ownerChatOf(input.orgId, input.agentId);
  if (owner === undefined)
    return yield* invalid("Kin can't find your direct chat with the owner to put the card in.");
  const now = yield* Clock.currentTimeMillis;
  const at = iso(now);
  const older = yield* sql<{ cardId: string }>`SELECT DISTINCT card_id AS "cardId"
    FROM kin_social_posts WHERE org_id = ${input.orgId} AND group_id = ${input.group.groupId}
      AND card_id IS NOT NULL AND state = 'proposed' ORDER BY card_id`;
  const widgetId = KinWidgetId.make(`kin-social:${input.group.groupId}:${now.toString(36)}`);
  const chatId = KinChatId.make(owner.chatId);
  const message = yield* repo.insertMessage({
    orgId: input.orgId,
    chatId,
    audience: "owner",
    messageId: KinMessageId.make(widgetId),
    author: { _tag: "system" },
    kind: "system",
    body: WEEK_TEXT,
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
  // The card's pictures are read as this message's, so the owner's screens may show them.
  const files = new Set(input.drafts.flatMap((draft) => mediaOf(draft)?.attachmentId ?? []));
  for (const attachmentId of files)
    yield* showFile({ orgId: input.orgId, chatId, messageId: message.messageId, attachmentId });
  const ids = input.drafts.map((draft) => draft.postId);
  yield* sql`UPDATE kin_social_posts SET state = 'proposed', card_id = ${widgetId},
      updated_at = ${now}
    WHERE org_id = ${input.orgId} AND post_id IN ${sql.in(ids)}`;
  const card = yield* weekState(input.orgId, widgetId, {
    groupId: input.group.groupId,
    group: { kind: input.group.partyId === null ? "own" : "client", label: input.group.label },
    title: input.title,
    confirmedAt: null,
    clientReview:
      input.group.partyId === null
        ? null
        : { ok: false, notedAt: null, preview: null, making: false },
    replaced: false,
  });
  const widget = {
    orgId: input.orgId,
    chatId,
    messageId: message.messageId,
    widgetId,
    widgetClass: "native" as const,
    type: KIN_SOCIAL_WEEK_CARD,
    state: card,
    source: null,
    feed: null,
    awaiting: [KinPersonId.make(owner.personId)],
    pinnedAt: null,
    closedAt: null,
    updatedAt: at,
  };
  yield* repo.insertWidget({ ...widget, audience: "owner" });
  for (const { cardId } of older)
    if (cardId !== widgetId)
      yield* refreshWeekCard(input.orgId, cardId, (card) => ({ ...card, replaced: true }));
  yield* sql.afterCommit(
    hub.publish({ type: "message.posted", orgId: input.orgId, message: { ...message, widgetId } }),
  );
  yield* sql.afterCommit(
    hub.publish({ type: "widget.updated", orgId: input.orgId, widget: { ...widget, revision: 1 } }),
  );
  return { cardId: widgetId, card };
});

const LABELS: Record<KinSocialWeekCardAction, string> = {
  remove: "Remove",
  confirm: "Confirm",
  undo: "Undo",
  retry: "Retry",
  client_ok: "Client said OK",
  preview: "Make a preview",
};

/** What a tap says before anything changes; the server finishes every tap, so none wakes Social. */
export const describeWeekTap = Effect.fn("KinSocialCards.describeWeek")(function* (
  widget: KinWidget,
  actionId: string,
  value: unknown,
) {
  const card = yield* decodeWeek(widget.state).pipe(
    Effect.mapError(() => invalid("Invalid widget state.")),
  );
  if (!isWeekAction(actionId)) return yield* invalid("Unknown card action.");
  const post =
    typeof value === "string" ? card.posts.find((one) => one.postId === value) : undefined;
  const needsPost = actionId === "remove" || actionId === "undo" || actionId === "retry";
  if (needsPost && post === undefined) return yield* invalid("That post isn't on this card.");
  const text =
    post === undefined
      ? `Tapped "${LABELS[actionId]}" on ${card.group.label}'s posts`
      : `Tapped "${LABELS[actionId]}" on the ${post.account.name} post for ${post.when}`;
  return { card, action: actionId, value, text, wake: false as const };
});

const ownerTap = Effect.fn("KinSocialCards.ownerTap")(function* (
  widget: KinWidget,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* sql<{ personId: string }>`SELECT a.owner_person_id AS "personId"
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${widget.orgId} AND l.owner_chat_id = ${widget.chatId} ORDER BY l.agent_id`;
  if (
    owner === undefined ||
    !(yield* mayActAsOwner(widget.orgId, KinPersonId.make(personId), owner).pipe(
      Effect.orElseSucceed(() => false),
    ))
  )
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner confirms posts.",
    });
});

/**
 * In the tap's transaction, for the person the server authenticated. Confirm covers exactly the
 * posts the card showed (`digest`), each checked again against its group: its account must be
 * one the group's key reaches, and its time far enough ahead that the service won't post it at
 * once. The scheduler hands them over after the commit.
 */
export const applyWeekTap = Effect.fn("KinSocialCards.applyWeek")(function* (
  widget: KinWidget,
  tap: Effect.Success<ReturnType<typeof describeWeekTap>>,
  personId: string,
) {
  yield* ownerTap(widget, personId);
  const sql = yield* SqlClient.SqlClient;
  const orgId = widget.orgId;
  const now = yield* Clock.currentTimeMillis;
  const zone = yield* ownerZone(orgId);
  const card = tap.card;
  if (card.replaced) return yield* invalid("A newer card for these posts replaced this one.");
  const row = typeof tap.value === "string" ? yield* postById(orgId, tap.value) : undefined;
  if (row !== undefined && row.cardId !== widget.widgetId)
    return yield* invalid("That post isn't on this card.");
  let next = card;
  switch (tap.action) {
    case "remove": {
      if (row?.state !== "proposed")
        return yield* invalid("Only a post waiting for Confirm can be removed.");
      yield* sql`UPDATE kin_social_posts SET state = 'removed', updated_at = ${now}
        WHERE org_id = ${orgId} AND post_id = ${row.postId} AND state = 'proposed'`;
      break;
    }
    case "confirm": {
      if (card.confirmedAt !== null) return yield* invalid("These posts are already confirmed.");
      if (card.clientReview !== null && !card.clientReview.ok)
        return yield* invalid(
          `Turn on "${card.group.label} said OK" first: a client's posts go out only with their OK.`,
        );
      const proposed = (yield* postsOfCard(orgId, widget.widgetId)).filter(
        (post) => post.state === "proposed",
      );
      if (proposed.length === 0) return yield* invalid("No posts are left to confirm.");
      // The card must still say exactly what the rows say: Confirm signs what was shown.
      if (tap.value !== card.digest || digestOf(proposed) !== card.digest)
        return yield* invalid(
          "The posts changed since this card was drawn. Look again, then Confirm.",
        );
      const group = yield* ownerLevelGroup(orgId, card.groupId);
      if (group === undefined)
        return yield* invalid(
          `${card.group.label}'s accounts were removed. Connect them again first.`,
        );
      if (group.problem !== null) return yield* invalid(`${group.label}: ${group.problem}`);
      const accounts = new Set(accountsOf(group).map((account) => account.accountId));
      for (const post of proposed) {
        if (
          post.groupId !== group.groupId ||
          post.accountId === null ||
          !accounts.has(post.accountId)
        )
          return yield* invalid(
            `A post on this card isn't for one of ${group.label}'s accounts, so nothing was scheduled.`,
          );
        if (post.atMs < now + CONFIRM_LEAD_MS)
          return yield* invalid(
            `${whenLabel(post.atMs, zone)} is too soon to schedule. Remove that post, or ask Social for a later time.`,
          );
      }
      yield* sql`UPDATE kin_social_posts SET state = 'scheduling', digest = ${card.digest},
          confirmed_at = ${now}, confirmed_by = ${personId}, reason = NULL, updated_at = ${now}
        WHERE org_id = ${orgId} AND card_id = ${widget.widgetId} AND state = 'proposed'`;
      next = { ...card, confirmedAt: iso(now) };
      break;
    }
    case "undo": {
      if (row === undefined || (row.state !== "scheduled" && row.state !== "scheduling"))
        return yield* invalid("Only a scheduled post can be undone.");
      if (row.atMs - UNDO_CLOSES_MS <= now)
        return yield* invalid("It goes out in a few minutes, so Undo has closed.");
      yield* sql`UPDATE kin_social_posts SET state = 'undoing', updated_at = ${now}
        WHERE org_id = ${orgId} AND post_id = ${row.postId}`;
      break;
    }
    case "retry": {
      if (row?.state !== "failed") return yield* invalid("Only a failed post can be retried.");
      yield* sql`UPDATE kin_social_posts SET state = 'scheduling', reason = NULL,
          attempt_at = NULL, updated_at = ${now}
        WHERE org_id = ${orgId} AND post_id = ${row.postId} AND state = 'failed'`;
      break;
    }
    case "client_ok": {
      if (card.clientReview === null) return yield* invalid("This card is for our own accounts.");
      const ok = tap.value === true;
      next = { ...card, clientReview: { ...card.clientReview, ok, notedAt: ok ? iso(now) : null } };
      break;
    }
    case "preview": {
      if (card.clientReview === null) return yield* invalid("This card is for our own accounts.");
      next = { ...card, clientReview: { ...card.clientReview, making: true } };
      break;
    }
  }
  const state = yield* weekState(orgId, widget.widgetId, next);
  const done = state.posts.every((post) => ["removed", "cancelled", "posted"].includes(post.state));
  return { state, closed: done && state.confirmedAt !== null };
});

/**
 * A file belongs to one message. A picture sent in a chat stays that message's and the card shows
 * it from there; only a file no message holds yet (a preview Kin made) becomes the card's.
 */
const showFile = Effect.fn("KinSocialCards.showFile")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly messageId: KinMessageId;
  readonly attachmentId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const held = yield* sql`SELECT 1 FROM kin_message_attachments
    WHERE attachment_id = ${input.attachmentId} LIMIT 1`;
  if (held.length === 0) yield* (yield* KinChatRepository).attachCardFile(input);
});

/** A pack: everything to post by hand, in the owner's chat with the agent. */
export const writePackCard = Effect.fn("KinSocialCards.writePack")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly packId: string;
  readonly where: string;
  readonly why: string;
  readonly caption: string;
  readonly media: KinSocialMedia | null;
  readonly atMs: number;
  readonly reminderId: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const owner = yield* ownerChatOf(input.orgId, input.agentId);
  if (owner === undefined)
    return yield* invalid("Kin can't find your direct chat with the owner to put the pack in.");
  const at = iso(yield* Clock.currentTimeMillis);
  const widgetId = KinWidgetId.make(`kin-social-pack:${input.packId}`);
  const chatId = KinChatId.make(owner.chatId);
  const message = yield* repo.insertMessage({
    orgId: input.orgId,
    chatId,
    audience: "owner",
    messageId: KinMessageId.make(widgetId),
    author: { _tag: "system" },
    kind: "system",
    body: PACK_TEXT,
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
  if (input.media !== null)
    yield* showFile({
      orgId: input.orgId,
      chatId,
      messageId: message.messageId,
      attachmentId: input.media.attachmentId,
    });
  const state: KinSocialPackCard = {
    text: PACK_TEXT,
    packId: input.packId,
    where: input.where,
    why: input.why,
    caption: input.caption,
    media: input.media,
    at: iso(input.atMs),
    when: whenLabel(input.atMs, yield* ownerZone(input.orgId)),
    reminderId: input.reminderId,
    posted: null,
  };
  const widget = {
    orgId: input.orgId,
    chatId,
    messageId: message.messageId,
    widgetId,
    widgetClass: "native" as const,
    type: KIN_SOCIAL_PACK_CARD,
    state,
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: at,
  };
  yield* repo.insertWidget({ ...widget, audience: "owner" });
  yield* sql.afterCommit(
    hub.publish({ type: "message.posted", orgId: input.orgId, message: { ...message, widgetId } }),
  );
  yield* sql.afterCommit(
    hub.publish({ type: "widget.updated", orgId: input.orgId, widget: { ...widget, revision: 1 } }),
  );
  return { cardId: widgetId };
});

export const describePackTap = Effect.fn("KinSocialCards.describePack")(function* (
  widget: KinWidget,
  actionId: string,
) {
  const card = yield* decodePack(widget.state).pipe(
    Effect.mapError(() => invalid("Invalid widget state.")),
  );
  if (!isPackAction(actionId)) return yield* invalid("Unknown card action.");
  return {
    card,
    action: actionId,
    text: `Tapped "Posted" on the pack for ${card.where}`,
    wake: false as const,
  };
});

export const applyPackTap = Effect.fn("KinSocialCards.applyPack")(function* (
  widget: KinWidget,
  tap: Effect.Success<ReturnType<typeof describePackTap>>,
  personId: string,
) {
  yield* ownerTap(widget, personId);
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE kin_social_posts SET state = 'posted', updated_at = ${now}
    WHERE org_id = ${widget.orgId} AND post_id = ${tap.card.packId} AND kind = 'pack'`;
  return { state: { ...tap.card, posted: iso(now) } satisfies KinSocialPackCard, closed: true };
});
