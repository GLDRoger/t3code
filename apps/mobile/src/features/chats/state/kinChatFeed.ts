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
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";

import type { KinHost } from "./kinHost";
import { applyKinChatHistory, type KinChatClosedReason, type KinChatState } from "./kinInboxModel";
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
  if (host.probe._tag === "error" && chat?._tag !== "Success") {
    return { _tag: "error", message: "Couldn't reach Kin.", retry: "orgs" };
  }
  if (chat === null || chat._tag === "Initial") {
    return host.connected ? { _tag: "loading" } : { _tag: "offline" };
  }
  if (chat._tag === "Success") {
    const { value } = chat.value;
    if (value.left) return { _tag: "gone", reason: "left" };
    if (value.closed !== null) return { _tag: "gone", reason: value.closed };
    return {
      _tag: "ready",
      environmentId: host.environmentId,
      connected: host.connected,
      chat: chat.value,
    };
  }
  if (!host.connected) return { _tag: "offline" };
  const error = Cause.squash(chat.cause);
  if (isAuthorizationError(error)) return { _tag: "unauthorized" };
  const message = error instanceof Error && error.message.length > 0 ? error.message : null;
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

const foldRunId = (message: KinMessage) =>
  message.author._tag === "agent" && message.status !== "deleted" ? message.floorRunId : null;

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
  let previousAuthor: string | null = null;

  const pushMessage = (message: KinMessage) => {
    if (isSystem(message)) {
      rows.push({ type: "system", key: message.messageId, message });
      previousAuthor = null;
      return;
    }
    const own = message.author._tag === "human" && message.author.personId === viewer.personId;
    const author = authorKey(message);
    rows.push({
      type: "message",
      key: message.messageId,
      message,
      own,
      authorLabel: kinAuthorLabel(message, viewer),
      authorKind: message.author._tag === "agent" ? "agent" : "person",
      showAuthor: !own && previousAuthor !== author,
    });
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
    const decision = run.findLast((message) => message.intent === "decision")?.body ?? null;
    const expanded = expandedRuns.has(runId);
    rows.push({
      type: "fold",
      key: `fold:${runId}:${first.messageId}`,
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
