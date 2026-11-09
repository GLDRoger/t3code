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

import type { MarkdownImageRequest } from "../../../native/SelectableMarkdownText";
import type { KinRouteHost } from "./kinHost";
import {
  applyKinChatHistory,
  emptyKinChat,
  type KinChatClosedReason,
  type KinChatState,
} from "./kinInboxModel";
import { kinLinkLabel, kinSafeWebUrl } from "./kinLinks";
import { kinReplyKey, type KinHeldDraft } from "./kinLive";
import { kinSentences } from "./kinScreenState";
import type { KinSynced } from "./kinStreams";

export const KIN_HISTORY_PAGE_SIZE = 50;

// Screen state

export type KinChatScreenState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "offline" }
  | { readonly _tag: "noHost" }
  /** The route's environment isn't paired with this device. */
  | { readonly _tag: "unpaired" }
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
  host: KinRouteHost,
  chat: AsyncResult.AsyncResult<KinSynced<KinChatState>, unknown> | null,
): KinChatScreenState {
  if (host._tag === "searching") return { _tag: "loading" };
  if (host._tag === "none") return { _tag: "noHost" };
  if (host._tag === "unpaired") return { _tag: "unpaired" };
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
  /** A reply still streaming. Its key is its durable message's, so the bubble stays in place. */
  | {
      readonly type: "draft";
      readonly key: string;
      readonly draft: KinHeldDraft;
      readonly authorLabel: string;
      readonly showAuthor: boolean;
    }
  | { readonly type: "system"; readonly key: string; readonly message: KinMessage }
  /** Starts each local day; `label` is relative to the day the rows were built on. */
  | { readonly type: "day"; readonly key: string; readonly label: string }
  | {
      readonly type: "fold";
      readonly key: string;
      readonly runId: string;
      readonly count: number;
      readonly authors: ReadonlyArray<string>;
      /** The run's last `decision` message body, if it reached one. */
      readonly decision: string | null;
      readonly expanded: boolean;
      /** The run's latest seq, seen once the fold is on screen. */
      readonly lastSeq: number;
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

// A bridged reply shares its draft's key, so the list keeps the bubble when the message lands.
const messageRowKey = (message: KinMessage) =>
  message.author._tag === "agent" && message.clientMessageId?.startsWith("reply:")
    ? message.clientMessageId
    : message.messageId;

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
  const row: MessageRow = { type: "message", key: messageRowKey(message), message, ...fields };
  messageRows.set(message, row);
  return row;
}

type DayRow = Extract<KinFeedRow, { readonly type: "day" }>;
const dayRows = new WeakMap<KinMessage, DayRow>();

function dayRow(first: KinMessage, day: string, now: Date): DayRow {
  const label = kinDayLabel(first.createdAt, now);
  const held = dayRows.get(first);
  if (held !== undefined && held.key === `day:${day}` && held.label === label) return held;
  const row: DayRow = { type: "day", key: `day:${day}`, label };
  dayRows.set(first, row);
  return row;
}

// Agents by agent id, so a draft (which names only its agent) groups with the messages before it.
const authorKey = (message: KinMessage) =>
  message.author._tag === "system"
    ? "system"
    : message.author._tag === "agent"
      ? `agent:${message.author.agentId}`
      : message.author.memberId;

/**
 * Feed rows, oldest first, then streaming drafts. A floor run of two or more consecutive agent
 * messages from more than one agent folds into one line (chat spec, interface rule 3); an
 * expanded run lists its messages after that line. One agent's run shows as grouped bubbles.
 */
export function buildKinFeedRows(
  messages: ReadonlyArray<KinMessage>,
  viewer: KinFeedViewer,
  expandedRuns: ReadonlySet<string>,
  now: Date = new Date(),
  drafts: ReadonlyArray<KinHeldDraft> = [],
): ReadonlyArray<KinFeedRow> {
  const visible = messages.filter((message) => message.status !== "dismissed");
  const rows: KinFeedRow[] = [];
  const foldKeys = new Set<string>();
  let previousAuthor: string | null = null;
  let previousDay: string | null = null;

  const startDay = (message: KinMessage) => {
    const day = kinLocalDayKey(message.createdAt);
    if (day === previousDay) return;
    previousDay = day;
    previousAuthor = null;
    rows.push(dayRow(message, day, now));
  };

  const pushMessage = (message: KinMessage) => {
    startDay(message);
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
    const run = visible.slice(index, end);
    if (runId === null || new Set(run.map(authorKey)).size < 2) {
      run.forEach(pushMessage);
      index = end;
      continue;
    }
    startDay(first);
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
      lastSeq: run[run.length - 1]!.seq,
    });
    previousAuthor = null;
    if (expanded) run.forEach(pushMessage);
    index = end;
  }
  for (const draft of drafts) {
    const day = kinLocalDayKey(draft.startedAt);
    if (day !== previousDay) {
      previousDay = day;
      previousAuthor = null;
      rows.push({ type: "day", key: `day:${day}`, label: kinDayLabel(draft.startedAt, now) });
    }
    const author = `agent:${draft.agentId}`;
    rows.push({
      type: "draft",
      key: kinReplyKey(draft.draftId),
      draft,
      authorLabel: viewer.agentNames.get(draft.agentId) ?? "Agent",
      showAuthor: previousAuthor !== author,
    });
    previousAuthor = author;
  }
  return rows;
}

/** The local calendar day of an ISO time, as `2026-11-08`. */
export function kinLocalDayKey(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const kinWeekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const kinFullDateFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** A day separator: "Today", "Yesterday", "Mon, 3 Nov", or with the year once it differs. */
export function kinDayLabel(iso: string, now: Date = new Date()): string {
  const day = kinLocalDayKey(iso);
  if (day === kinLocalDayKey(now.toISOString())) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === kinLocalDayKey(yesterday.toISOString())) return "Yesterday";
  const date = new Date(iso);
  return date.getFullYear() === now.getFullYear()
    ? kinWeekdayFormat.format(date)
    : kinFullDateFormat.format(date);
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
    .map((line) => (/[.!?…:;,]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

export interface KinMessageLink {
  /** The link text, plus its real host when the text doesn't name it. */
  readonly label: string;
  readonly href: string;
}

/** The web links in a message, in order, for the bubble's accessibility actions. */
export function kinMessageLinks(markdown: string): ReadonlyArray<KinMessageLink> {
  const links: KinMessageLink[] = [];
  const add = (text: string, href: string) => {
    const url = kinSafeWebUrl(href);
    if (url !== null) links.push({ label: kinLinkLabel(text.trim() || href, url), href: url.href });
  };
  const rest = markdown.replace(MARKDOWN_LINK, (match, label: string, href: string) => {
    if (!match.startsWith("!")) add(label, href);
    return " ";
  });
  for (const match of rest.matchAll(BARE_URL)) add(match[1]!, match[1]!);
  return links.filter((link, index) => links.findIndex((l) => l.href === link.href) === index);
}

/** What a tapped Kin link opens: web links only, so a bubble can't dial, text or deep-link. */
export function kinLinkToOpen(href: string): string | null {
  return kinSafeWebUrl(href)?.href ?? null;
}

/**
 * Agents write message bodies, and loading `![](https://x.example/p.png?d=…)` would send data out
 * the moment the chat opens. Every image resolves to an empty source: the renderer keeps its
 * placeholder and requests nothing.
 */
export const kinImageSource = () => ({ uri: "" });

const MARKDOWN_IMAGE = /!\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;

/**
 * The body a bubble renders: images become text before parsing, so no build (even one without
 * the native parser) can load or open an agent's image URL.
 */
export const kinBodyMarkdown = (body: string) =>
  body
    .replace(MARKDOWN_IMAGE, (_match, alt: string) =>
      alt.trim() ? `Image: ${alt.trim()}` : "Image",
    )
    .replace(HTML_IMAGE, "Image");

/** A standalone image block, drawn as text in its place. */
export const kinImageText = (image: MarkdownImageRequest) =>
  image.alt?.trim() ? `Image: ${image.alt.trim()}` : "Image";

/** The bubble's one VoiceOver label: "Tech lead, agent. Payments test fixed. 9:30." */
export function kinMessageLabel(row: MessageRow, time: string): string {
  const { message } = row;
  const deleted = message.status === "deleted";
  const parts = [row.own ? "You" : `${row.authorLabel}, ${row.authorKind}`];
  if (deleted) parts.push("Message deleted");
  else {
    parts.push(kinPlainText(message.body));
  }
  parts.push(time);
  if (message.status === "suggested") parts.push("Suggestion, not sent yet");
  else if (message.editedAt !== null && !deleted) parts.push("Edited");
  return kinSentences(parts);
}

// Follow-the-end

/** The latest seq a feed row shows; day lines show none. */
export function kinRowSeq(row: KinFeedRow): number {
  switch (row.type) {
    case "message":
    case "system":
      return row.message.seq;
    case "fold":
      return row.lastSeq;
    case "day":
    case "draft":
      return 0;
  }
}

/**
 * Messages from others past `seenSeq`, the latest seq the reader has had on screen. The
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

/**
 * The seq to mark read, or null. Only while the reader sees the end, past the last seq marked or
 * already tried, and while the inbox counts anything unread (`null` while the inbox hasn't loaded).
 * A refused seq stays tried until the caller rearms it, so a failing host isn't asked on every render.
 */
export function kinSeqToMarkRead(input: {
  readonly seesEnd: boolean;
  readonly latestSeq: number;
  readonly markedSeq: number;
  readonly attemptedSeq: number;
  readonly unread: number | null;
}): number | null {
  const sent = Math.max(input.markedSeq, input.attemptedSeq);
  if (!input.seesEnd || input.latestSeq <= sent || input.unread === 0) return null;
  return input.latestSeq;
}

/** Whether a refused mark may be retried: the reader came back online or back to the chat. */
export const kinMarkReadRearms = (
  was: { readonly connected: boolean; readonly focused: boolean },
  now: { readonly connected: boolean; readonly focused: boolean },
) => (now.connected && !was.connected) || (now.focused && !was.focused);

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
