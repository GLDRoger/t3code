import {
  KinChatSummary,
  KinMessage,
  KinPresence,
  KinReaction,
  KinWaitingItem,
  KinWidget,
  type KinChatId,
  type KinChatListEvent,
  type KinChatStreamEvent,
  type KinChatHistoryResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  applyKinDraft,
  applyKinLiveBacklog,
  applyKinPresence,
  KinHeldDraft,
  settleKinDrafts,
} from "./kinLive";
import { applyKinReaction, mergeKinReactions } from "./kinReactions";

export const KIN_CACHED_MESSAGE_LIMIT = 50;

// Chat list + Waiting on you

export const KinInboxState = Schema.Struct({
  chats: Schema.Array(KinChatSummary),
  /** Unresolved rows only. */
  waiting: Schema.Array(KinWaitingItem),
});
export type KinInboxState = typeof KinInboxState.Type;

/** `left` is local: the viewer's own chat stream reported a non-null `leftAt`. */
export type KinInboxEvent =
  | KinChatListEvent
  | { readonly _tag: "left"; readonly chatId: KinChatId };

export const emptyKinInbox: KinInboxState = { chats: [], waiting: [] };

export function applyKinInboxEvent(state: KinInboxState, event: KinInboxEvent): KinInboxState {
  switch (event._tag) {
    case "snapshot":
      return {
        chats: event.chats,
        waiting: event.waiting.filter((item) => item.resolvedAt === null),
      };
    case "chat": {
      const index = state.chats.findIndex((chat) => chat.chatId === event.chat.chatId);
      if (index === -1) return { ...state, chats: [...state.chats, event.chat] };
      // An upsert read before a newer one can arrive after it; never move a chat backwards.
      if (event.chat.lastSeq < state.chats[index]!.lastSeq) return state;
      const chats = state.chats.slice();
      chats[index] = event.chat;
      return { ...state, chats };
    }
    case "waiting": {
      const rest = state.waiting.filter((item) => item.waitingId !== event.item.waitingId);
      return {
        ...state,
        waiting: event.item.resolvedAt === null ? [...rest, event.item] : rest,
      };
    }
    case "left":
      return {
        chats: state.chats.filter((chat) => chat.chatId !== event.chatId),
        waiting: state.waiting.filter((item) => item.chatId !== event.chatId),
      };
  }
}

export interface KinInboxRow {
  readonly chat: KinChatSummary;
  readonly waitingCount: number;
}

export interface KinInboxView {
  /** Chats with anything waiting first, then most recent activity first. */
  readonly rows: ReadonlyArray<KinInboxRow>;
  /** Waiting on you, oldest first. */
  readonly waiting: ReadonlyArray<KinWaitingItem>;
  readonly unreadCount: number;
  readonly waitingCount: number;
}

const activityAt = (chat: KinChatSummary) => chat.lastMessageAt ?? chat.createdAt;

export function selectKinInboxView(state: KinInboxState): KinInboxView {
  const waitingByChat = new Map<KinChatId, number>();
  for (const item of state.waiting) {
    waitingByChat.set(item.chatId, (waitingByChat.get(item.chatId) ?? 0) + 1);
  }
  const rows = state.chats
    .filter((chat) => chat.archivedAt === null)
    .map((chat) => ({ chat, waitingCount: waitingByChat.get(chat.chatId) ?? 0 }))
    .sort((a, b) => {
      const waiting = Number(b.waitingCount > 0) - Number(a.waitingCount > 0);
      if (waiting !== 0) return waiting;
      const activity = activityAt(b.chat).localeCompare(activityAt(a.chat));
      return activity !== 0 ? activity : a.chat.chatId.localeCompare(b.chat.chatId);
    });
  return {
    rows,
    waiting: [...state.waiting].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.waitingId.localeCompare(b.waitingId),
    ),
    unreadCount: rows.reduce((sum, row) => sum + row.chat.unread, 0),
    waitingCount: state.waiting.length,
  };
}

// One chat's feed

export const KinChatState = Schema.Struct({
  /** Ascending by seq, one per message. */
  messages: Schema.Array(KinMessage),
  /** Highest revision per widget. */
  widgets: Schema.Array(KinWidget),
  /** Highest seq up to which nothing is missing; the `afterSeq` to resume the stream with. */
  contiguousSeq: Schema.Number,
  /** The last backlog's `lastChangeSeq`; the `afterChangeSeq` that replays edits made offline. */
  changeSeq: Schema.Number,
  reads: Schema.Record(Schema.String, Schema.Number),
  /** The server reported a gap of more than 200; reload the latest page with history. */
  needsHistoryReload: Schema.Boolean,
  /** The viewer left; the stream has ended. Never cached. */
  left: Schema.Boolean,
  /** The host refused the chat stream for good; it has ended. Never cached. */
  closed: Schema.NullOr(
    Schema.Literals([
      "not_found",
      "not_allowed",
      "disabled",
      "widget_changed",
      "use_approvals",
      "invalid_state",
      "limit",
      "floor_not_granted",
      "floor_closed",
    ]),
  ),
  /** Streaming replies, oldest first; hub-only, never cached. */
  drafts: Schema.Array(KinHeldDraft).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** What each working agent is doing; hub-only, never cached. */
  presence: Schema.Array(KinPresence).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Live reactions on held messages; a backlog that carries them replaces the set. */
  reactions: Schema.Array(KinReaction).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type KinChatState = typeof KinChatState.Type;

export const emptyKinChat: KinChatState = {
  messages: [],
  widgets: [],
  contiguousSeq: 0,
  changeSeq: 0,
  reads: {},
  needsHistoryReload: false,
  left: false,
  closed: null,
  drafts: [],
  presence: [],
  reactions: [],
};

/** Every Kin refusal but `unavailable`, which the stream retries. */
export type KinChatClosedReason = NonNullable<KinChatState["closed"]>;

function mergeMessages(
  current: ReadonlyArray<KinMessage>,
  incoming: ReadonlyArray<KinMessage>,
  /** Unheld messages below this seq are dropped; history pages pass none to prepend. */
  floorSeq = Number.NEGATIVE_INFINITY,
): ReadonlyArray<KinMessage> {
  if (incoming.length === 0) return current;
  // Live messages arrive in order past the last held one. Anything else, such as a backlog's
  // changed older messages, replaces the held copy of that message.
  if (
    (current.length === 0
      ? incoming[0]!.seq >= floorSeq
      : incoming[0]!.seq > current[current.length - 1]!.seq) &&
    incoming.every((message, index) => index === 0 || message.seq > incoming[index - 1]!.seq)
  ) {
    return [...current, ...incoming];
  }
  const byId = new Map(current.map((message) => [message.messageId, message]));
  let changed = false;
  for (const message of incoming) {
    // Inserting a changed message below the window would strand the seqs between it and the
    // window: "Load earlier" pages from the oldest held seq.
    if (message.seq < floorSeq && !byId.has(message.messageId)) continue;
    // A later copy of the same message carries its newest status or edit.
    byId.set(message.messageId, message);
    changed = true;
  }
  return changed ? [...byId.values()].sort((a, b) => a.seq - b.seq) : current;
}

/** The lowest seq a stream event may insert: the oldest held, or past a reset's cursor. */
const streamFloor = (state: KinChatState) =>
  state.messages[0]?.seq ?? (state.needsHistoryReload ? state.contiguousSeq + 1 : 0);

function mergeWidgets(
  current: ReadonlyArray<KinWidget>,
  incoming: ReadonlyArray<KinWidget>,
): ReadonlyArray<KinWidget> {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((widget) => [widget.widgetId, widget]));
  let changed = false;
  for (const widget of incoming) {
    const held = byId.get(widget.widgetId);
    if (held !== undefined && widget.revision <= held.revision) continue;
    byId.set(widget.widgetId, widget);
    changed = true;
  }
  return changed ? [...byId.values()] : current;
}

/** Walks forward from `from` over held seqs. Gaps stay open until a backlog fills them. */
function advanceContiguous(messages: ReadonlyArray<KinMessage>, from: number): number {
  let seq = from;
  for (const message of messages) {
    if (message.seq === seq + 1) seq = message.seq;
    else if (message.seq > seq + 1) break;
  }
  return seq;
}

export function applyKinChatEvent(
  state: KinChatState,
  event: KinChatStreamEvent,
  now: string = new Date().toISOString(),
): KinChatState {
  switch (event._tag) {
    case "backlog": {
      const messages = mergeMessages(state.messages, event.messages, streamFloor(state));
      // The server sent everything visible to this viewer through `lastSeq`, so seqs it skipped
      // (suggestions shown to others) are not gaps.
      const filled = Math.max(state.contiguousSeq, event.lastSeq);
      const widgets = mergeWidgets(state.widgets, event.widgets);
      const contiguousSeq = advanceContiguous(messages, filled);
      // Only a fully applied backlog moves it; live events keep this snapshot cursor.
      const changeSeq = event.lastChangeSeq ?? state.changeSeq;
      const live = applyKinLiveBacklog(state, event, messages, now);
      // The host sends the chat's live reactions in full; a backlog without them keeps ours.
      const reactions = event.reactions ?? state.reactions;
      if (
        reactions === state.reactions &&
        messages === state.messages &&
        widgets === state.widgets &&
        contiguousSeq === state.contiguousSeq &&
        changeSeq === state.changeSeq &&
        live.drafts.length === 0 &&
        live.presence.length === 0 &&
        state.drafts.length === 0 &&
        state.presence.length === 0
      ) {
        return state;
      }
      return { ...state, messages, widgets, contiguousSeq, changeSeq, reactions, ...live };
    }
    case "reset":
      return {
        ...state,
        messages: [],
        widgets: [],
        contiguousSeq: event.lastSeq,
        changeSeq: event.lastChangeSeq ?? 0,
        needsHistoryReload: true,
      };
    case "message": {
      const messages = mergeMessages(state.messages, [event.message], streamFloor(state));
      if (messages === state.messages) return state;
      return {
        ...state,
        messages,
        contiguousSeq: advanceContiguous(messages, state.contiguousSeq),
        drafts: settleKinDrafts(state.drafts, [event.message]),
      };
    }
    case "widget": {
      const widgets = mergeWidgets(state.widgets, [event.widget]);
      return widgets === state.widgets ? state : { ...state, widgets };
    }
    case "member":
      return event.member.leftAt === null ? state : { ...state, left: true };
    case "read": {
      const held = state.reads[event.memberId] ?? 0;
      if (event.seq <= held) return state;
      return { ...state, reads: { ...state.reads, [event.memberId]: event.seq } };
    }
    case "draft": {
      const drafts = applyKinDraft(state.drafts, state.messages, event, now);
      return drafts === state.drafts ? state : { ...state, drafts };
    }
    case "presence": {
      const presence = applyKinPresence(state.presence, event);
      // A run that ended without its durable message can't finish its draft.
      const drafts =
        event.presence === null
          ? state.drafts.filter((draft) => draft.agentId !== event.agentId)
          : state.drafts;
      if (presence === state.presence && drafts.length === state.drafts.length) return state;
      return {
        ...state,
        presence,
        drafts: drafts.length === state.drafts.length ? state.drafts : drafts,
      };
    }
    case "reaction": {
      const reactions = applyKinReaction(state.reactions, event.reaction);
      return reactions === state.reactions ? state : { ...state, reactions };
    }
  }
}

/** A message from outside the stream, such as a send reply. It never advances `contiguousSeq`. */
export function addKinChatMessage(state: KinChatState, message: KinMessage): KinChatState {
  return { ...state, messages: mergeMessages(state.messages, [message]) };
}

/** An older page from `kin.chat.history`. */
export function applyKinChatHistory(state: KinChatState, page: KinChatHistoryResult): KinChatState {
  return {
    ...state,
    messages: mergeMessages(state.messages, page.messages),
    widgets: mergeWidgets(state.widgets, page.widgets),
    reactions: mergeKinReactions(state.reactions, page.reactions ?? []),
    needsHistoryReload: false,
  };
}

/** The latest messages and the widgets they anchor, for the device cache. */
export function trimKinChatForCache(state: KinChatState): KinChatState {
  const messages = state.messages.slice(-KIN_CACHED_MESSAGE_LIMIT);
  const kept = new Set(messages.map((message) => message.messageId));
  return {
    ...state,
    messages,
    widgets: state.widgets.filter((widget) => kept.has(widget.messageId)),
    reactions: state.reactions.filter((reaction) => kept.has(reaction.messageId)),
    left: false,
    closed: null,
    drafts: [],
    presence: [],
  };
}
