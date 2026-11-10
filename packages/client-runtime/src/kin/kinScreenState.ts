// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type KinChatId,
  type KinAgentId,
  type KinChatSummary,
  type KinWaitingItem,
  type KinWaitingReason,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";

import type { SupervisorConnectionState } from "../connection/model.ts";
import type { KinSynced } from "./kinStreams.ts";
import type { KinHost } from "./kinHost.ts";
import { kinTapText } from "./kinTap.ts";
import type { KinInboxRow, KinInboxState } from "./kinInboxModel.ts";

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

type KinReadyScreenState = Extract<KinInboxScreenState, { readonly _tag: "ready" }>;

const kinClockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const kinDayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** "9:41" for a time today (by `now`'s local day), "7 Nov" for any other day. */
export function formatKinTime(date: Date, now: Date = new Date()): string {
  return date.toDateString() === now.toDateString()
    ? kinClockFormat.format(date)
    : kinDayFormat.format(date);
}

/** Where the Reconnect action on the Offline notice is: idle, waiting on the attempt, or failed. */
export type KinReconnectStatus = "idle" | "pending" | "failed";

export interface KinStaleNotice {
  readonly offline: boolean;
  readonly message: string;
}

/** The stale-data notice over cached Kin data, or null while it is live and connected. */
export function kinStaleNotice(
  data: { readonly connected: boolean; readonly live: boolean; readonly savedAt: string | null },
  reconnect: KinReconnectStatus,
  formatTime: (date: Date) => string,
): KinStaleNotice | null {
  if ((data.connected && data.live) || data.savedAt === null) return null;
  const updated = `Last updated ${formatTime(new Date(data.savedAt))}.`;
  if (data.connected) return { offline: false, message: `Updating. ${updated}` };
  const status =
    reconnect === "pending"
      ? "Reconnecting…"
      : reconnect === "failed"
        ? "Couldn't reconnect."
        : "Offline.";
  return { offline: true, message: `${status} ${updated}` };
}

/** The stale-data notice over a ready inbox, or null while it is live and connected. */
export function kinInboxNotice(
  state: KinReadyScreenState,
  reconnect: KinReconnectStatus,
  formatTime: (date: Date) => string,
): KinStaleNotice | null {
  return kinStaleNotice(
    { connected: state.connected, live: state.inbox.live, savedAt: state.inbox.savedAt },
    reconnect,
    formatTime,
  );
}

/**
 * One connection state seen while Reconnect waits, from `before`, the state at the press. The
 * attempt has failed once a connect attempt ends without connecting, or when the supervisor
 * won't try: the device is offline or the host is blocked.
 */
export function kinReconnectStep(
  attempted: boolean,
  state: SupervisorConnectionState,
  before: SupervisorConnectionState,
): { readonly attempted: boolean; readonly outcome: "pending" | "connected" | "failed" } {
  if (state.phase === "connected") return { attempted, outcome: "connected" };
  if (state.phase === "connecting") return { attempted: true, outcome: "pending" };
  const wontTry =
    before.phase === "offline" ||
    (state !== before && (state.phase === "offline" || state.phase === "blocked"));
  return { attempted, outcome: attempted || wontTry ? "failed" : "pending" };
}

/** One VoiceOver label from its parts, each read as a sentence without doubling its end mark. */
export function kinSentences(parts: ReadonlyArray<string | null>): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(" ");
}

// Chat list rows and the Waiting on you banner

/** Who the viewer is and what agents are called, from the host's `kin.orgs.list`. */
export interface KinDirectory {
  readonly agentNames: ReadonlyMap<string, string>;
  readonly me: ReadonlySet<string>;
}

const emptyKinDirectory: KinDirectory = { agentNames: new Map(), me: new Set() };

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
  readonly avatar: KinAvatarView;
  /** "Lead" in "Lead: Payments test fixed". */
  readonly author: string | null;
  readonly preview: string;
  readonly sentAt: string | null;
  readonly unread: number;
  /** The viewer muted this chat's notifications; it still counts toward the badge. */
  readonly muted: boolean;
}

/**
 * A blobatar is drawn from `seed`, an id rather than a name, so a rename keeps the face and web
 * and mobile draw the same one.
 */
export interface KinAvatarView {
  readonly kind: "agent" | "person" | "group";
  readonly seed: string;
}

/** An agent's avatar, the same wherever it shows: a chat row, the chat's title, its status line. */
export const kinAgentAvatar = (agentId: string): KinAvatarView => ({
  kind: "agent",
  seed: `agent:${agentId}`,
});

/** A chat's avatar: its group, or the other side of a direct chat. */
export function kinAvatarView(
  chat: KinChatSummary,
  counterpart: KinChatSummary["members"][number] | null,
): KinAvatarView {
  if (chat.kind === "team_group" || chat.kind === "project_group") {
    return { kind: "group", seed: `chat:${chat.chatId}` };
  }
  const principal = counterpart?.principal;
  if (principal?._tag === "person") return { kind: "person", seed: `person:${principal.personId}` };
  if (principal?._tag === "agent") return kinAgentAvatar(principal.agentId);
  return { kind: "agent", seed: `chat:${chat.chatId}` };
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

/** A chat's last message as one plain line for a list. */
function kinMessagePreview(last: KinChatSummary["lastMessage"]): string {
  if (last === null) return "No messages yet";
  if (last.status === "deleted") return "Message deleted";
  if (last.kind === "widget_action") return kinTapText(last.body);
  // Hosts before the quiet-turn change posted their own bookkeeping as system rows.
  if (last.kind === "system" && last.widgetId?.startsWith("memory-changes:")) return "Saved a note";
  if (last.kind === "system" && last.widgetId?.startsWith("deferral:")) return "Set a reminder";
  return kinPreviewText(last.body) || "Message";
}

/** Whether the viewer's own membership mutes this chat's pushes right now. */
export function kinChatMuted(
  chat: Pick<KinChatSummary, "members">,
  me: ReadonlySet<string>,
  now: number,
): boolean {
  return chat.members.some(
    (member) =>
      member.leftAt === null &&
      member.principal._tag === "person" &&
      me.has(member.principal.personId) &&
      member.mutedUntil != null &&
      Date.parse(member.mutedUntil) > now,
  );
}

export function kinChatRowView(
  row: KinInboxRow,
  directory: KinDirectory,
  now = Date.now(),
): KinChatRowView {
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
        : last.author._tag !== "human"
          ? null
          : directory.me.has(last.author.personId)
            ? "You"
            : (chat.lastAuthorName ?? null);
  const preview = kinMessagePreview(last);
  return {
    chatId: chat.chatId,
    title,
    avatar: kinAvatarView(chat, counterpart),
    author: last?.status === "deleted" ? null : author,
    preview,
    sentAt: chat.lastMessageAt,
    unread: chat.unread,
    muted: kinChatMuted(chat, directory.me, now),
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
    view.muted ? "Muted" : null,
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
 * The lead this viewer owns in a chat: the agent of a direct chat the viewer owns, for owner-only
 * controls such as interrupt. The host checks ownership again on every call.
 */
export function kinOwnedLeadAgentId(
  chat: Pick<KinChatSummary, "kind" | "members">,
  personId: string | null,
): KinAgentId | null {
  if (chat.kind !== "direct" || personId === null) return null;
  const active = chat.members.filter((member) => member.leftAt === null);
  const owns = active.some(
    (member) =>
      member.role === "owner" &&
      member.principal._tag === "person" &&
      member.principal.personId === personId,
  );
  const agent = active.find((member) => member.principal._tag === "agent")?.principal;
  return owns && agent?._tag === "agent" ? agent.agentId : null;
}

/** A direct chat's agent by name; null for other chats or an agent the directory doesn't name. */
export function kinDirectAgentName(
  chat: Pick<KinChatSummary, "kind" | "members">,
  agentNames: ReadonlyMap<string, string>,
): string | null {
  if (chat.kind !== "direct") return null;
  for (const member of chat.members) {
    if (member.leftAt !== null || member.principal._tag !== "agent") continue;
    const name = agentNames.get(member.principal.agentId);
    if (name !== undefined) return name;
  }
  return null;
}

/** The host's title, else the chat's agent by name: the host leaves direct chats untitled. */
export function kinChatTitle(
  chat: Pick<KinChatSummary, "title" | "kind" | "members">,
  agentNames: ReadonlyMap<string, string>,
): string {
  if (chat.title !== null) return chat.title;
  if (chat.kind !== "direct") return "Chat";
  return kinDirectAgentName(chat, agentNames) ?? "Direct chat";
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
