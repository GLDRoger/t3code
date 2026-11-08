import {
  EnvironmentAuthorizationError,
  KinTaskCardState,
  type EnvironmentId,
  type KinChatHistoryInput,
  type KinChatId,
  type KinMessage,
  type KinOrgsListResult,
  type KinPersonId,
  type KinWidget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import type { KinHost } from "./kinHost";
import {
  applyKinChatHistory,
  emptyKinChat,
  type KinChatClosedReason,
  type KinChatState,
} from "./kinInboxModel";
import type { KinSynced } from "./kinStreams";

export const KIN_HISTORY_PAGE_SIZE = 50;

// Screen state

export type KinChatScreenState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "offline" }
  | { readonly _tag: "noHost" }
  | { readonly _tag: "unauthorized" }
  | { readonly _tag: "noIdentity" }
  | { readonly _tag: "error"; readonly message: string; readonly retry: "orgs" | "chat" }
  /** The stream ended: the viewer left, or the host refused the chat. */
  | { readonly _tag: "gone"; readonly reason: "left" | KinChatClosedReason }
  | {
      readonly _tag: "ready";
      readonly environmentId: EnvironmentId;
      readonly connected: boolean;
      readonly chat: KinSynced<KinChatState>;
      /** The stream failed after the feed loaded; shown above the cached list. */
      readonly error: string | null;
    };

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** The same host rules as the inbox (`kinInboxScreenState`), over one chat's stream. */
export function kinChatScreenState(
  host: KinHost,
  chat: AsyncResult.AsyncResult<KinSynced<KinChatState>, unknown> | null,
): KinChatScreenState {
  if (host._tag === "searching") return { _tag: "loading" };
  if (host._tag === "none") return { _tag: "noHost" };
  if (host.probe._tag === "unauthorized") return { _tag: "unauthorized" };
  if (host.probe._tag === "noIdentity") return { _tag: "noIdentity" };
  if (host.probe._tag === "error" && !host.probe.transient) {
    return { _tag: "error", message: host.probe.message, retry: "orgs" };
  }
  const loaded = chat === null ? null : Option.getOrNull(AsyncResult.value(chat));
  if (host.probe._tag === "error" && loaded === null) {
    return { _tag: "error", message: "Couldn't reach Kin.", retry: "orgs" };
  }
  if (chat === null || chat._tag === "Initial") {
    return host.connected ? { _tag: "loading" } : { _tag: "offline" };
  }
  let message: string | null = null;
  if (chat._tag === "Failure") {
    const error = Cause.squash(chat.cause);
    if (isAuthorizationError(error)) return { _tag: "unauthorized" };
    const text = error instanceof Error && error.message.length > 0 ? error.message : null;
    message = text ?? "Kin didn't answer.";
  }
  if (loaded !== null) {
    const { value } = loaded;
    if (value.left) return { _tag: "gone", reason: "left" };
    if (value.closed !== null) return { _tag: "gone", reason: value.closed };
    return {
      _tag: "ready",
      environmentId: host.environmentId,
      connected: host.connected,
      chat: loaded,
      // Offline, the notice already says why the feed stopped.
      error: host.connected ? message : null,
    };
  }
  if (!host.connected) return { _tag: "offline" };
  return { _tag: "error", message: message ?? "Kin didn't answer.", retry: "chat" };
}

// Paging

/** The next "Load earlier" page, or null when nothing older can exist. */
export function kinEarlierPage(
  chatId: KinChatId,
  messages: ReadonlyArray<KinMessage>,
  exhausted: boolean,
): KinChatHistoryInput | null {
  const oldest = messages[0];
  if (exhausted || oldest === undefined || oldest.seq <= 1) return null;
  return { chatId, beforeSeq: oldest.seq, limit: KIN_HISTORY_PAGE_SIZE };
}

/** "Load earlier" pages held under the stream, and the page in flight. */
export interface KinPaging {
  readonly earlier: KinChatState;
  /** The stream's oldest seq when the first earlier page was read. */
  readonly anchorSeq: number | null;
  readonly exhausted: boolean;
  /** The page in flight, by request number. */
  readonly request: number | null;
  readonly error: string | null;
}

export const initialKinPaging: KinPaging = {
  earlier: emptyKinChat,
  anchorSeq: null,
  exhausted: false,
  request: null,
  error: null,
};

/**
 * The paging that still fits the stream. Earlier pages end where the stream started when they
 * were read; once a reset or reload moves the stream's start later, they would leave a hole.
 */
export function kinActivePaging(paging: KinPaging, live: KinChatState): KinPaging {
  if (paging.anchorSeq === null) return paging;
  const oldest = live.messages[0]?.seq;
  return live.needsHistoryReload || oldest === undefined || oldest > paging.anchorSeq
    ? initialKinPaging
    : paging;
}

/** Earlier pages under the live stream. The stream's copy of a message or widget wins. */
export function mergeKinFeed(live: KinChatState, earlier: KinChatState): KinChatState {
  if (earlier.messages.length === 0 && earlier.widgets.length === 0) return live;
  const merged = applyKinChatHistory(earlier, {
    messages: live.messages,
    widgets: live.widgets,
    hasMore: false,
  });
  return { ...live, messages: merged.messages, widgets: merged.widgets };
}

// Rows

export interface KinFeedViewer {
  readonly personId: KinPersonId | null;
  readonly agentNames: ReadonlyMap<string, string>;
}

export type KinFeedRow =
  | {
      readonly type: "message";
      readonly key: string;
      readonly message: KinMessage;
      readonly own: boolean;
      /** Who wrote it, for others' messages; the author line shows only when `showAuthor`. */
      readonly authorLabel: string;
      readonly authorKind: "agent" | "person";
      readonly showAuthor: boolean;
    }
  | { readonly type: "system"; readonly key: string; readonly message: KinMessage }
  | {
      readonly type: "fold";
      readonly key: string;
      readonly runId: string;
      readonly count: number;
      readonly authors: ReadonlyArray<string>;
      /** The run's last `decision` message body, if it reached one. */
      readonly decision: string | null;
      readonly expanded: boolean;
    };

const ROLE_LABELS = { owner: "Owner", member: "Member", guest: "Guest" } as const;

export function kinAuthorLabel(message: KinMessage, viewer: KinFeedViewer): string {
  const { author } = message;
  if (author._tag === "agent") return viewer.agentNames.get(author.agentId) ?? "Agent";
  if (author._tag === "human") return ROLE_LABELS[message.authorRole];
  return "Kin";
}

const isSystem = (message: KinMessage) =>
  message.kind === "system" || message.author._tag === "system";

// A deleted message stays in its run, so deleting one doesn't split the fold in two.
const foldRunId = (message: KinMessage) =>
  message.author._tag === "agent" ? message.floorRunId : null;

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;

// Rows for unchanged messages keep their identity, so one new message doesn't redraw every bubble.
const messageRows = new WeakMap<KinMessage, MessageRow>();

function messageRow(message: KinMessage, fields: Omit<MessageRow, "type" | "key" | "message">) {
  const held = messageRows.get(message);
  if (
    held !== undefined &&
    held.own === fields.own &&
    held.authorLabel === fields.authorLabel &&
    held.authorKind === fields.authorKind &&
    held.showAuthor === fields.showAuthor
  ) {
    return held;
  }
  const row: MessageRow = { type: "message", key: message.messageId, message, ...fields };
  messageRows.set(message, row);
  return row;
}

const authorKey = (message: KinMessage) =>
  message.author._tag === "system" ? "system" : message.author.memberId;

/**
 * Feed rows, oldest first. Two or more consecutive agent messages from one floor run fold into
 * one line (chat spec, interface rule 3); an expanded run lists its messages after that line.
 */
export function buildKinFeedRows(
  messages: ReadonlyArray<KinMessage>,
  viewer: KinFeedViewer,
  expandedRuns: ReadonlySet<string>,
): ReadonlyArray<KinFeedRow> {
  const visible = messages.filter((message) => message.status !== "dismissed");
  const rows: KinFeedRow[] = [];
  const foldKeys = new Set<string>();
  let previousAuthor: string | null = null;

  const pushMessage = (message: KinMessage) => {
    if (isSystem(message)) {
      rows.push({ type: "system", key: message.messageId, message });
      previousAuthor = null;
      return;
    }
    const own = message.author._tag === "human" && message.author.personId === viewer.personId;
    const author = authorKey(message);
    rows.push(
      messageRow(message, {
        own,
        authorLabel: kinAuthorLabel(message, viewer),
        authorKind: message.author._tag === "agent" ? "agent" : "person",
        showAuthor: !own && previousAuthor !== author,
      }),
    );
    previousAuthor = author;
  };

  for (let index = 0; index < visible.length;) {
    const first = visible[index]!;
    const runId = foldRunId(first);
    let end = index + 1;
    if (runId !== null) {
      while (end < visible.length && foldRunId(visible[end]!) === runId) end += 1;
    }
    if (runId === null || end - index < 2) {
      pushMessage(first);
      index += 1;
      continue;
    }
    const run = visible.slice(index, end);
    const authors = [...new Set(run.map((message) => kinAuthorLabel(message, viewer)))];
    const decision =
      run.findLast((message) => message.intent === "decision" && message.status !== "deleted")
        ?.body ?? null;
    const expanded = expandedRuns.has(runId);
    // Keyed by run so a page prepended into the run keeps the row; a run split by another
    // author falls back to its first message.
    const key = foldKeys.has(`fold:${runId}`)
      ? `fold:${runId}:${first.messageId}`
      : `fold:${runId}`;
    foldKeys.add(key);
    rows.push({
      type: "fold",
      key,
      runId,
      count: run.length,
      authors,
      decision,
      expanded,
    });
    previousAuthor = null;
    if (expanded) run.forEach(pushMessage);
    index = end;
  }
  return rows;
}

// Accessibility

const MARKDOWN_LINK = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const BARE_URL = /<?(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])>?/g;

/** Markdown read aloud: link text without its address, no markers, one sentence per line. */
export function kinPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(MARKDOWN_LINK, "$1")
        .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
        .replace(/\*\*|__|~~|[*`]/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

export interface KinMessageLink {
  readonly label: string;
  readonly href: string;
}

/** Links in a message, in order, for the bubble's accessibility actions. */
export function kinMessageLinks(markdown: string): ReadonlyArray<KinMessageLink> {
  const links: KinMessageLink[] = [];
  const rest = markdown.replace(MARKDOWN_LINK, (match, label: string, href: string) => {
    if (!match.startsWith("!")) links.push({ label: label.trim() || href, href });
    return " ";
  });
  for (const match of rest.matchAll(BARE_URL)) links.push({ label: match[1]!, href: match[1]! });
  return links.filter((link, index) => links.findIndex((l) => l.href === link.href) === index);
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The bubble's one VoiceOver label: "Tech lead, agent. Payments test fixed. 9:30." */
export function kinMessageLabel(row: MessageRow, time: string): string {
  const { message } = row;
  const deleted = message.status === "deleted";
  const parts = [row.own ? "You." : `${row.authorLabel}, ${row.authorKind}.`];
  if (deleted) parts.push("Message deleted.");
  else {
    const body = kinPlainText(message.body);
    if (body.length > 0) parts.push(sentence(body));
    if (message.widgetId !== null) parts.push("This card needs a newer version of Kin.");
  }
  parts.push(`${time}.`);
  if (message.status === "suggested") parts.push("Suggestion, not sent yet.");
  else if (message.editedAt !== null && !deleted) parts.push("Edited.");
  return parts.join(" ");
}

// Follow-the-end

/**
 * Messages from others past `seenSeq`, the latest seq when the reader left the end. The
 * "New messages" pill shows while this is above zero and the reader is away from the end.
 */
export function kinUnseenCount(
  messages: ReadonlyArray<KinMessage>,
  seenSeq: number,
  viewerPersonId: KinPersonId | null,
): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.seq <= seenSeq) break;
    const own = message.author._tag === "human" && message.author.personId === viewerPersonId;
    if (!own && message.status !== "dismissed" && !isSystem(message)) count += 1;
  }
  return count;
}

export const latestKinSeq = (messages: ReadonlyArray<KinMessage>) =>
  messages[messages.length - 1]?.seq ?? 0;

// Header

const isTaskState = Schema.is(KinTaskCardState);

/** The header's live status, from task widgets only, never from message text (DESIGN 8.2). */
export function kinChatStatusLine(widgets: ReadonlyArray<KinWidget>): string | null {
  let working = 0;
  for (const widget of widgets) {
    if (widget.type !== "task" || widget.closedAt !== null) continue;
    if (isTaskState(widget.state) && widget.state.status === "working") working += 1;
  }
  if (working === 0) return null;
  return working === 1 ? "Working on 1 task" : `Working on ${working} tasks`;
}

/** The viewer and agent names from the host's `kin.orgs.list` answer. */
export function kinFeedViewer(orgs: KinOrgsListResult | null, orgId: string | null): KinFeedViewer {
  if (orgs === null) return { personId: null, agentNames: new Map() };
  const org = orgs.orgs.find((candidate) => candidate.orgId === orgId) ?? orgs.orgs[0];
  const me = orgs.me.find((entry) => entry.orgId === org?.orgId) ?? orgs.me[0];
  return {
    personId: me?.personId ?? null,
    agentNames: new Map(org?.agents.map((agent) => [agent.agentId, agent.displayName]) ?? []),
  };
}
