import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type KinChatId,
  type KinChatSummary,
  type KinWaitingItem,
  type KinWaitingReason,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";

import type { KinSynced } from "./kinStreams";
import type { KinHost } from "./kinHost";
import type { KinInboxRow, KinInboxState, KinInboxView } from "./kinInboxModel";

/** What a Kin screen reading the inbox shows. */
export type KinInboxScreenState =
  | { readonly _tag: "loading" }
  /** The saved host is offline and nothing is cached yet. */
  | { readonly _tag: "offline" }
  | { readonly _tag: "noHost" }
  | { readonly _tag: "unauthorized" }
  /** The host runs Kin but maps this session to no person. */
  | { readonly _tag: "noIdentity" }
  | {
      readonly _tag: "error";
      readonly message: string;
      /** The failed read: the host probe or the inbox stream. */
      readonly retry: "orgs" | "inbox";
    }
  | {
      readonly _tag: "ready";
      readonly environmentId: EnvironmentId;
      readonly connected: boolean;
      readonly inbox: KinSynced<KinInboxState>;
    };

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.length > 0 ? error.message : "Kin didn't answer.";
}

/** `inbox` is null until a host is known. */
export function kinInboxScreenState(
  host: KinHost,
  inbox: AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null,
): KinInboxScreenState {
  if (host._tag === "searching") return { _tag: "loading" };
  if (host._tag === "none") return { _tag: "noHost" };
  if (host.probe._tag === "unauthorized") return { _tag: "unauthorized" };
  if (host.probe._tag === "noIdentity") return { _tag: "noIdentity" };
  if (host.probe._tag === "error" && !host.probe.transient) {
    return { _tag: "error", message: host.probe.message, retry: "orgs" };
  }
  // A transient probe failure says nothing about Kin, so a live or cached inbox still shows.
  if (host.probe._tag === "error" && inbox?._tag !== "Success") {
    return { _tag: "error", message: "Couldn't reach Kin.", retry: "orgs" };
  }
  if (inbox === null || inbox._tag === "Initial") {
    return host.connected ? { _tag: "loading" } : { _tag: "offline" };
  }
  if (inbox._tag === "Success") {
    return {
      _tag: "ready",
      environmentId: host.environmentId,
      connected: host.connected,
      inbox: inbox.value,
    };
  }
  if (!host.connected) return { _tag: "offline" };
  if (isAuthorizationError(Cause.squash(inbox.cause))) return { _tag: "unauthorized" };
  return { _tag: "error", message: causeMessage(inbox.cause), retry: "inbox" };
}

/** The time `selectKinInboxView` sorts by (kinInboxModel's `activityAt`). */
const activityAt = (row: KinInboxRow) => row.chat.lastMessageAt ?? row.chat.createdAt;

type KinReadyScreenState = Extract<KinInboxScreenState, { readonly _tag: "ready" }>;

const kinClockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const kinDayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** "9:41" for a time today (by `now`'s local day), "7 Nov" for any other day. */
export function formatKinTime(date: Date, now: Date = new Date()): string {
  return date.toDateString() === now.toDateString()
    ? kinClockFormat.format(date)
    : kinDayFormat.format(date);
}

/** The stale-data notice over a ready inbox, or null while it is live and connected. */
export function kinInboxNotice(
  state: KinReadyScreenState,
  formatTime: (date: Date) => string,
): { readonly offline: boolean; readonly message: string } | null {
  const { savedAt } = state.inbox;
  if ((state.connected && state.inbox.live) || savedAt === null) return null;
  const status = state.connected ? "Updating" : "Offline";
  return {
    offline: !state.connected,
    message: `${status}. Last updated ${formatTime(new Date(savedAt))}.`,
  };
}

/** One VoiceOver label from its parts, each read as a sentence without doubling its end mark. */
export function kinSentences(parts: ReadonlyArray<string | null>): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(" ");
}

/** The home row's VoiceOver label: "Kin. Payments test fixed. 3 unread." */
export function kinHomeLabel(subtitle: string | null, unreadCount: number): string {
  return kinSentences(["Kin", subtitle, unreadCount > 0 ? `${unreadCount} unread` : null]);
}

/** The home row's second line. */
export function kinHomeSubtitle(
  state: KinInboxScreenState,
  view: KinInboxView | null,
): string | null {
  if (view !== null && view.waitingCount > 0) return `Waiting on you · ${view.waitingCount}`;
  switch (state._tag) {
    case "offline":
      return "Offline";
    case "unauthorized":
      return "This device can't read Kin chats";
    case "noIdentity":
      return "Kin doesn't know you on this server yet";
    case "error":
      return "Couldn't load chats";
    case "ready": {
      if (!state.connected) return "Offline";
      // Rows put waiting chats first, so pick the newest by activity, not the first row.
      const latest = view?.rows.reduce<KinInboxRow | null>(
        (best, row) => (best === null || activityAt(row) > activityAt(best) ? row : best),
        null,
      );
      return latest?.chat.lastMessage?.body ?? "No messages yet";
    }
    default:
      return null;
  }
}

// Chat list rows and the Waiting on you banner

/** Who the viewer is and what agents are called, from the host's `kin.orgs.list`. */
export interface KinDirectory {
  readonly agentNames: ReadonlyMap<string, string>;
  readonly me: ReadonlySet<string>;
}

export const emptyKinDirectory: KinDirectory = { agentNames: new Map(), me: new Set() };

export function kinDirectory(host: KinHost): KinDirectory {
  if (host._tag !== "host") return emptyKinDirectory;
  const { probe } = host;
  if (probe._tag !== "ready" && probe._tag !== "noIdentity") return emptyKinDirectory;
  return {
    agentNames: new Map(
      probe.orgs.orgs.flatMap((org) =>
        org.agents.map((agent) => [agent.agentId, agent.displayName] as const),
      ),
    ),
    me: new Set(probe.orgs.me.map((me) => me.personId)),
  };
}

export interface KinChatRowView {
  readonly chatId: KinChatId;
  readonly title: string;
  readonly avatar: { readonly kind: "agent" | "person"; readonly initials: string };
  /** "Lead" in "Lead: Payments test fixed". */
  readonly author: string | null;
  readonly preview: string;
  readonly sentAt: string | null;
  readonly unread: number;
}

/** First letters of the first two words: "Tech lead" is "TL". */
export function kinInitials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => Array.from(word)[0]!.toUpperCase());
  return letters.length > 0 ? letters.join("") : "?";
}

/** Message markdown as one plain line. */
export function kinPreviewText(body: string): string {
  return body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/```[^\s`]*/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function kinChatRowView(row: KinInboxRow, directory: KinDirectory): KinChatRowView {
  const { chat } = row;
  const others = chat.members.filter(
    (member) =>
      member.leftAt === null &&
      !(member.principal._tag === "person" && directory.me.has(member.principal.personId)),
  );
  // A direct chat is one person and one agent, so the other side is its agent.
  const counterpart =
    others.find((member) => member.principal._tag === "agent") ?? others[0] ?? null;
  const title = kinChatTitle(chat, directory.agentNames);
  const last = chat.lastMessage;
  const author =
    last === null
      ? null
      : last.author._tag === "agent"
        ? (directory.agentNames.get(last.author.agentId) ?? null)
        : last.author._tag === "human" && directory.me.has(last.author.personId)
          ? "You"
          : null;
  const preview =
    last === null
      ? "No messages yet"
      : last.status === "deleted"
        ? "Message deleted"
        : kinPreviewText(last.body) || "Message";
  return {
    chatId: chat.chatId,
    title,
    avatar: {
      kind: counterpart?.principal._tag === "person" ? "person" : "agent",
      initials: kinInitials(title),
    },
    author: last?.status === "deleted" ? null : author,
    preview,
    sentAt: chat.lastMessageAt,
    unread: chat.unread,
  };
}

/** "Tech lead, agent. Payments test fixed, PR 212 ready. 9:30. 3 unread." */
export function kinChatRowLabel(view: KinChatRowView, formatTime: (date: Date) => string): string {
  const preview =
    view.author !== null && view.author !== view.title
      ? `${view.author}: ${view.preview}`
      : view.preview;
  return [
    `${view.title}, ${view.avatar.kind}`,
    preview.replace(/[.!?]+$/, ""),
    view.sentAt === null ? null : formatTime(new Date(view.sentAt)),
    view.unread > 0 ? `${view.unread} unread` : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .map((part) => `${part}.`)
    .join(" ");
}

const WAITING_REASON_NOUNS: Record<KinWaitingReason, string> = {
  approval: "approval",
  decision: "decision",
  question: "question",
  suggestion: "suggestion",
  mention: "mention",
};

export interface KinWaitingBannerView {
  readonly count: number;
  /** Up to two kinds of item, oldest first, then the rest: "1 approval · 2 questions · 1 more". */
  readonly summary: string;
  readonly accessibilityLabel: string;
}

/**
 * Waiting items carry a reason but no title, so the banner names kinds of item.
 * `waiting` is oldest first, as `selectKinInboxView` returns it. Null when nothing waits.
 */
export function kinWaitingBannerView(
  waiting: ReadonlyArray<KinWaitingItem>,
): KinWaitingBannerView | null {
  if (waiting.length === 0) return null;
  const counts = new Map<KinWaitingReason, number>();
  for (const item of waiting) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  const named = [...counts].slice(0, 2);
  const parts = named.map(
    ([reason, count]) => `${count} ${WAITING_REASON_NOUNS[reason]}${count === 1 ? "" : "s"}`,
  );
  const rest = waiting.length - named.reduce((sum, [, count]) => sum + count, 0);
  const items = waiting.length === 1 ? "1 item" : `${waiting.length} items`;
  return {
    count: waiting.length,
    summary: [...parts, ...(rest > 0 ? [`${rest} more`] : [])].join(" · "),
    accessibilityLabel: `Waiting on you, ${items}: ${parts.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
  };
}

/**
 * The footer's target: the viewer's direct chat with the lead. `kin.orgs.list` carries no agent
 * role yet, so the lead is the agent that joined a direct chat first: setup creates it before any
 * other. Activity order never decides, so the target stays put as chats update.
 */
export function kinLeadChatId(rows: ReadonlyArray<KinInboxRow>): KinChatId | null {
  let best: { readonly chatId: KinChatId; readonly joinedAt: string } | null = null;
  for (const { chat } of rows) {
    if (chat.kind !== "direct") continue;
    const agent = chat.members.find((member) => member.principal._tag === "agent");
    const joinedAt = agent?.joinedAt ?? chat.createdAt;
    if (
      best === null ||
      joinedAt < best.joinedAt ||
      (joinedAt === best.joinedAt && chat.chatId < best.chatId)
    ) {
      best = { chatId: chat.chatId, joinedAt };
    }
  }
  return best?.chatId ?? null;
}

/** The host's title, else the chat's agent by name: the host leaves direct chats untitled. */
export function kinChatTitle(
  chat: Pick<KinChatSummary, "title" | "kind" | "members">,
  agentNames: ReadonlyMap<string, string>,
): string {
  if (chat.title !== null) return chat.title;
  if (chat.kind !== "direct") return "Chat";
  for (const member of chat.members) {
    if (member.leftAt !== null || member.principal._tag !== "agent") continue;
    const name = agentNames.get(member.principal.agentId);
    if (name !== undefined) return name;
  }
  return "Direct chat";
}

const WAITING_REASON_LABELS: Record<KinWaitingReason, string> = {
  approval: "Approval",
  decision: "Decision",
  question: "Question",
  suggestion: "Suggestion",
  mention: "Mention",
};

export interface KinWaitingRowView {
  readonly label: string;
  readonly chatTitle: string;
  /** The message that asks, when the inbox carries it; items have no text of their own. */
  readonly text: string | null;
  readonly createdAt: string;
}

export function kinWaitingRowView(
  item: KinWaitingItem,
  chats: ReadonlyArray<KinChatSummary>,
  agentNames: ReadonlyMap<string, string>,
): KinWaitingRowView {
  const chat = chats.find((held) => held.chatId === item.chatId);
  const last = chat?.lastMessage ?? null;
  const message = last !== null && last.messageId === item.messageId ? last : null;
  return {
    label: WAITING_REASON_LABELS[item.reason],
    chatTitle: chat === undefined ? "Direct chat" : kinChatTitle(chat, agentNames),
    text: message === null || message.status === "deleted" ? null : message.body,
    createdAt: item.createdAt,
  };
}
