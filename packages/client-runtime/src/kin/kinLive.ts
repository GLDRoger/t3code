import {
  KinAgentId,
  type KinChatStreamEvent,
  type KinPresence,
  type KinMessage,
  type KinPresenceState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Hub-only stream state: a lead's streaming reply and what it is doing. Never cached.

type DraftEvent = Extract<KinChatStreamEvent, { readonly _tag: "draft" }>;
type PresenceEvent = Extract<KinChatStreamEvent, { readonly _tag: "presence" }>;
type BacklogEvent = Extract<KinChatStreamEvent, { readonly _tag: "backlog" }>;

/** A draft as this client holds it. */
export const KinHeldDraft = Schema.Struct({
  /** The turn item; its message carries `clientMessageId: "reply:<draftId>"`. */
  draftId: Schema.String,
  agentId: KinAgentId,
  text: Schema.String,
  /** When this client first saw it, for the author line and day. */
  startedAt: Schema.String,
});
export type KinHeldDraft = typeof KinHeldDraft.Type;

interface KinLiveState {
  readonly drafts: ReadonlyArray<KinHeldDraft>;
  readonly presence: ReadonlyArray<KinPresence>;
}

export const kinReplyKey = (draftId: string) => `reply:${draftId}`;

const agentOf = (message: KinMessage) =>
  message.author._tag === "agent" ? message.author.agentId : null;

/** The durable message that ends this draft: its reply id, or the same agent's text grown from it. */
function settles(message: KinMessage, draft: KinHeldDraft): boolean {
  if (message.clientMessageId !== undefined) {
    return message.clientMessageId === kinReplyKey(draft.draftId);
  }
  return agentOf(message) === draft.agentId && message.body.startsWith(draft.text.trimEnd());
}

/** Drops drafts that a held message has made durable. */
export function settleKinDrafts(
  drafts: ReadonlyArray<KinHeldDraft>,
  messages: ReadonlyArray<KinMessage>,
): ReadonlyArray<KinHeldDraft> {
  if (drafts.length === 0) return drafts;
  const next = drafts.filter((draft) => !messages.some((message) => settles(message, draft)));
  return next.length === drafts.length ? drafts : next;
}

/**
 * One append-only delta. A delta whose offset doesn't match what's held is ignored until `end`,
 * the durable message, or the next backlog. `end` drops the draft: its message, if any, is held.
 */
export function applyKinDraft(
  drafts: ReadonlyArray<KinHeldDraft>,
  messages: ReadonlyArray<KinMessage>,
  event: DraftEvent,
  now: string,
): ReadonlyArray<KinHeldDraft> {
  const index = drafts.findIndex((draft) => draft.draftId === event.draftId);
  if (event.end !== undefined) {
    return index === -1 ? drafts : drafts.filter((_, i) => i !== index);
  }
  if (index === -1) {
    if (event.offset !== 0 || event.text.length === 0) return drafts;
    const draft: KinHeldDraft = {
      draftId: event.draftId,
      agentId: event.agentId,
      text: event.text,
      startedAt: now,
    };
    // A late delta after the durable message must not bring the bubble back.
    if (messages.some((message) => settles(message, draft))) return drafts;
    return [...drafts, draft];
  }
  const held = drafts[index]!;
  if (event.offset !== held.text.length || event.text.length === 0) return drafts;
  const next = drafts.slice();
  next[index] = { ...held, text: held.text + event.text };
  return next;
}

export function applyKinPresence(
  presence: ReadonlyArray<KinPresence>,
  event: PresenceEvent,
): ReadonlyArray<KinPresence> {
  const rest = presence.filter((entry) => entry.agentId !== event.agentId);
  if (event.presence === null) return rest.length === presence.length ? presence : rest;
  return [...rest, event.presence];
}

/** A backlog's snapshot replaces what's held, keeping when each held draft started. */
export function applyKinLiveBacklog(
  state: KinLiveState,
  backlog: Pick<BacklogEvent, "drafts" | "presence">,
  messages: ReadonlyArray<KinMessage>,
  now: string,
): KinLiveState {
  const startedAt = new Map(state.drafts.map((draft) => [draft.draftId, draft.startedAt]));
  const drafts = settleKinDrafts(
    (backlog.drafts ?? []).map((draft) => ({
      draftId: draft.draftId,
      agentId: draft.agentId,
      text: draft.text,
      startedAt: startedAt.get(draft.draftId) ?? now,
    })),
    messages,
  );
  return { drafts, presence: backlog.presence ?? [] };
}

// The presence line

export const KIN_SLOW_START_AFTER_MS = 20_000;
/** The line's clock: it re-renders this often while it shows elapsed time, never faster. */
export const KIN_PRESENCE_TICK_MS = 15_000;
const LABEL_MAX = 60;

export interface KinPresenceLine {
  /** What the line reads, such as "Checking memory". */
  readonly text: string;
  /** Read aloud on change; it ignores elapsed time, so ticks aren't announced. */
  readonly announcement: string;
  readonly stalled: boolean;
  /** Short form for the header subtitle. */
  readonly subtitle: string;
}

const clip = (label: string) =>
  label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1).trimEnd()}…`;

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const DEFAULT_TEXT: Record<Exclude<KinPresenceState, "stalled">, string> = {
  seen: "Seen",
  starting: "Starting…",
  thinking: "Thinking…",
  working: "Working…",
  writing: "Writing…",
  paused: "Paused",
  deferred: "Waiting for budget",
};

/**
 * The one line for an agent's presence at `now`; null when there's nothing to show. The server
 * decides the state, stalls included; the client only counts the time since.
 */
export function kinPresenceLine(
  presence: KinPresence | undefined,
  now: number,
): KinPresenceLine | null {
  if (presence === undefined) return null;
  if (presence.state === "stalled") {
    const minutes = Math.max(2, Math.floor((now - Date.parse(presence.since)) / 60_000));
    return {
      text: `No output for ${minutes} min`,
      announcement: "No output",
      stalled: true,
      subtitle: "No output",
    };
  }
  const label = presence.label?.trim();
  const text = label ? clip(label) : DEFAULT_TEXT[presence.state];
  const line = { text, announcement: text, stalled: false, subtitle: text };
  if (presence.state !== "starting" || label) return line;
  const waited = now - Date.parse(presence.startedAt);
  return waited >= KIN_SLOW_START_AFTER_MS
    ? { ...line, text: `Starting · ${elapsed(waited)}` }
    : line;
}

/** Whether the line reads differently as time passes, so it needs the clock. */
export function kinPresenceNeedsClock(presence: KinPresence | undefined): boolean {
  return presence?.state === "stalled" || (presence?.state === "starting" && !presence.label);
}
