// @effect-diagnostics globalDate:off globalTimers:off - Pure presence helpers and a per-line hold timer for React, outside an Effect runtime.
import {
  KinAgentId,
  KinDraft,
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
  sourceWakeupId: KinDraft.fields.sourceWakeupId,
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

export function kinPostedReplyWakeup(message: KinMessage) {
  return message.progress !== true &&
    message.author._tag === "agent" &&
    message.kind === "text" &&
    message.status === "posted" &&
    message.relay === undefined &&
    message.body.trim() !== ""
    ? message.sourceWakeupId
    : undefined;
}

export function kinAskTurnKey(message: KinMessage) {
  return message.author._tag === "agent" && message.sourceWakeupId !== undefined
    ? JSON.stringify([
        message.orgId,
        message.chatId,
        message.author.agentId,
        message.author.threadId,
        message.sourceWakeupId,
      ])
    : null;
}

export function kinHeldAskCards(
  messages: ReadonlyArray<KinMessage>,
  presence: ReadonlyArray<KinPresence>,
) {
  if (presence.length === 0) return null;
  const active = new Map(
    presence
      .filter(
        (line) => line.wakeupId !== null && line.state !== "seen" && line.state !== "deferred",
      )
      .map((line) => [line.agentId, line.wakeupId]),
  );
  if (active.size === 0) return null;

  const replies = new Set<string>();
  const asks: Array<{ message: KinMessage; turn: string }> = [];
  for (const message of messages) {
    const { author, sourceWakeupId } = message;
    if (
      author._tag !== "agent" ||
      sourceWakeupId === undefined ||
      active.get(author.agentId) !== sourceWakeupId
    )
      continue;
    const turn = kinAskTurnKey(message);
    if (turn === null) continue;
    if (kinPostedReplyWakeup(message) !== undefined) replies.add(turn);
    else if (
      message.ordinaryTurnAsk === true &&
      message.status === "posted" &&
      message.widgetId !== null &&
      message.body.trim() === ""
    )
      asks.push({ message, turn });
  }
  const ids = new Set<string>();
  let readThroughSeq: number | undefined;
  for (const { message, turn } of asks) {
    if (replies.has(turn)) continue;
    readThroughSeq ??= message.seq - 1;
    ids.add(message.messageId);
  }
  return readThroughSeq === undefined ? null : { readThroughSeq, ids };
}

export function kinLatestReadableSeq(
  messages: ReadonlyArray<KinMessage>,
  presence: ReadonlyArray<KinPresence>,
) {
  return kinHeldAskCards(messages, presence)?.readThroughSeq ?? messages.at(-1)?.seq ?? 0;
}

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
      ...(event.sourceWakeupId === undefined ? {} : { sourceWakeupId: event.sourceWakeupId }),
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
  const prev = presence.find((entry) => entry.agentId === event.agentId);
  const rest = presence.filter((entry) => entry.agentId !== event.agentId);
  if (event.presence === null) return rest.length === presence.length ? presence : rest;
  carryLabelHold(prev, event.presence, Date.now());
  return [...rest, event.presence];
}

/** An opening snapshot replaces live state; a checkpoint has no live snapshot. */
export function applyKinLiveBacklog(
  state: KinLiveState,
  backlog: Pick<BacklogEvent, "drafts" | "presence">,
  messages: ReadonlyArray<KinMessage>,
  now: string,
): KinLiveState {
  const startedAt = new Map(state.drafts.map((draft) => [draft.draftId, draft.startedAt]));
  const drafts =
    backlog.drafts === undefined
      ? state.drafts
      : backlog.drafts.map((draft) => ({
          ...draft,
          startedAt: startedAt.get(draft.draftId) ?? now,
        }));
  return {
    drafts: settleKinDrafts(drafts, messages),
    presence: backlog.presence ?? state.presence,
  };
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
  /** Pulsing dots while the lead is queued or starting, a shimmer while it works. */
  readonly motion: "dots" | "shimmer" | "still";
}

// `seen` comes only from older servers; a lead's line then waits for its wake-up.
type ShownState = Exclude<KinPresenceState, "seen">;

const MOTION: Record<ShownState, KinPresenceLine["motion"]> = {
  starting: "dots",
  thinking: "shimmer",
  working: "shimmer",
  writing: "shimmer",
  paused: "still",
  deferred: "still",
  stalled: "still",
};

const clip = (label: string) =>
  label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1).trimEnd()}…`;

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const DEFAULT_TEXT: Record<Exclude<ShownState, "stalled">, string> = {
  starting: "Starting…",
  thinking: "Thinking…",
  working: "Working…",
  writing: "Writing a reply…",
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
  if (presence === undefined || presence.state === "seen") return null;
  if (presence.state === "stalled") {
    const minutes = Math.max(2, Math.floor((now - Date.parse(presence.since)) / 60_000));
    return {
      text: `No output for ${minutes} min`,
      announcement: "No output",
      stalled: true,
      subtitle: "No output",
      motion: MOTION.stalled,
    };
  }
  const label = presence.label?.trim();
  const text = label ? clip(label) : DEFAULT_TEXT[presence.state];
  const line = {
    text,
    announcement: text,
    stalled: false,
    subtitle: text,
    motion: MOTION[presence.state],
  };
  if (presence.state !== "starting") return line;
  const waited = now - Date.parse(presence.startedAt);
  return waited >= KIN_SLOW_START_AFTER_MS
    ? { ...line, text: `${label ? clip(label) : "Starting"} · ${elapsed(waited)}` }
    : line;
}

/** When the run being shown started, while the agent is busy on it; the line then shows a timer. */
export function kinPresenceTimerStart(presence: KinPresence | undefined): string | null {
  switch (presence?.state) {
    case "thinking":
    case "working":
    case "writing":
      return presence.startedAt;
    default:
      return null;
  }
}

/** Whether the line reads differently as time passes, so it needs the clock. */
export function kinPresenceNeedsClock(presence: KinPresence | undefined): boolean {
  return presence?.state === "stalled" || presence?.state === "starting";
}

// Stop on the working line

/** A run's Stop on its line: none, a plain one from the first second, or the stalled run's. */
export type KinPresenceStop = "none" | "offer" | "urgent";

/**
 * Who may stop an agent's run in this chat: in a direct chat, the person who owns its lead
 * (unless it is retired); in a group or the Team room, an owner or co-owner. The host decides.
 */
export function kinMayStopAgent(input: {
  readonly canInterrupt: boolean;
  readonly direct: boolean;
  readonly ownedAgentId: string | null;
  readonly retired: boolean;
  readonly ownerLevel: boolean;
}): (agentId: string) => boolean {
  if (!input.canInterrupt) return () => false;
  if (input.direct)
    return (agentId) =>
      !input.retired && input.ownedAgentId !== null && agentId === input.ownedAgentId;
  return () => input.ownerLevel;
}

function kinPresenceStop(
  presence: KinPresence | undefined,
  mayStop: (agentId: string) => boolean,
): KinPresenceStop {
  if (presence === undefined || presence.wakeupId === null || !mayStop(presence.agentId))
    return "none";
  switch (presence.state) {
    case "starting":
    case "thinking":
    case "working":
    case "writing":
      return "offer";
    case "stalled":
      return "urgent";
    default:
      return "none";
  }
}

/** Minimum time a non-"Thinking" label stays readable before a following "Thinking" replaces it. */
export const KIN_LABEL_HOLD_MS = 1_500;

export interface KinHeldLabel {
  readonly wakeupId: KinPresence["wakeupId"];
  readonly since: string;
  readonly line: KinPresenceLine;
  readonly until: number;
}

export interface KinLabelHoldSnapshot {
  readonly entries: ReadonlyMap<string, KinHeldLabel>;
  readonly expired: WeakSet<KinPresence>;
}

export interface KinLabelHold {
  /** Updates per-line holds from `presence` and arms or cancels at most one timer per line. */
  sync(presence: ReadonlyArray<KinPresence>): void;
  /** Immutable snapshot for `kinWorkingLines` and `useSyncExternalStore`. */
  snapshot(): KinLabelHoldSnapshot;
  /** Subscribes to hold expirations. */
  subscribe(listener: () => void): () => void;
  /** Cancels all pending timers and clears held state. */
  dispose(): void;
}

// Carries a brief tool label across fast tool-to-Thinking bursts that coalesce before React commits.
const carriedHolds = new WeakMap<KinPresence, KinHeldLabel>();

function isThinkingPresence(entry: KinPresence): boolean {
  if (entry.state !== "thinking") return false;
  const label = entry.label?.trim();
  return label === undefined || label === "" || label === "Thinking" || label === "Thinking…";
}

function isHoldablePresence(entry: KinPresence): boolean {
  return entry.state === "working" || entry.state === "writing" || entry.state === "starting";
}

function carryLabelHold(prev: KinPresence | undefined, next: KinPresence, now: number): void {
  if (isHoldablePresence(next)) {
    const line = kinPresenceLine(next, now);
    if (line === null) return;
    const prevHold = prev === undefined ? undefined : carriedHolds.get(prev);
    const same =
      prevHold !== undefined &&
      prevHold.wakeupId === next.wakeupId &&
      prevHold.since === next.since &&
      prevHold.line.text === line.text;
    carriedHolds.set(
      next,
      same
        ? prevHold
        : { wakeupId: next.wakeupId, since: next.since, line, until: now + KIN_LABEL_HOLD_MS },
    );
    return;
  }
  if (isThinkingPresence(next) && prev !== undefined) {
    const prevHold = carriedHolds.get(prev);
    if (prevHold !== undefined && prevHold.wakeupId === next.wakeupId && now < prevHold.until) {
      carriedHolds.set(next, prevHold);
    }
  }
}

/**
 * Per-chat hold controller for `kinWorkingLines`: keeps at most one `setTimeout` per working line
 * so brief tool labels stay readable for `KIN_LABEL_HOLD_MS` before "Thinking" replaces them.
 */
export function createKinLabelHold(): KinLabelHold {
  const entries = new Map<string, KinHeldLabel>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const holding = new Set<string>();
  const latest = new Map<string, KinPresence>();
  const expired = new WeakSet<KinPresence>();
  const listeners = new Set<() => void>();
  let current: KinLabelHoldSnapshot = { entries: new Map(), expired };

  const notifyAll = () => {
    for (const listener of listeners) listener();
  };

  const cancel = (agentId: string) => {
    const timer = timers.get(agentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(agentId);
    }
  };

  const arm = (agentId: string, until: number, now: number) => {
    cancel(agentId);
    const wait = Math.max(0, until - now);
    timers.set(
      agentId,
      setTimeout(() => {
        timers.delete(agentId);
        const wasHolding = holding.delete(agentId);
        const active = latest.get(agentId);
        if (active !== undefined) expired.add(active);
        if (entries.delete(agentId)) {
          current = { entries: new Map(entries), expired };
          if (wasHolding) notifyAll();
        }
      }, wait),
    );
  };

  return {
    sync(presence) {
      const now = Date.now();
      let changed = false;
      let notify = false;
      const activeIds = new Set<string>(presence.map((entry) => entry.agentId));
      for (const agentId of new Set([
        ...entries.keys(),
        ...timers.keys(),
        ...holding,
        ...latest.keys(),
      ])) {
        if (activeIds.has(agentId)) continue;
        cancel(agentId);
        holding.delete(agentId);
        latest.delete(agentId);
        if (entries.delete(agentId)) changed = true;
      }
      for (const entry of presence) {
        const agentId = entry.agentId;
        latest.set(agentId, entry);
        const raw = kinPresenceLine(entry, now);
        if (raw === null) {
          cancel(agentId);
          holding.delete(agentId);
          if (entries.delete(agentId)) changed = true;
          continue;
        }
        if (isHoldablePresence(entry)) {
          holding.delete(agentId);
          const carried = carriedHolds.get(entry);
          const existing = entries.get(agentId);
          const same =
            existing !== undefined &&
            existing.wakeupId === entry.wakeupId &&
            existing.since === entry.since &&
            existing.line.text === raw.text;
          if (!same) {
            const next: KinHeldLabel =
              carried !== undefined && carried.wakeupId === entry.wakeupId
                ? carried
                : {
                    wakeupId: entry.wakeupId,
                    since: entry.since,
                    line: raw,
                    until: now + KIN_LABEL_HOLD_MS,
                  };
            if (now < next.until) {
              entries.set(agentId, next);
              arm(agentId, next.until, now);
              changed = true;
            } else {
              cancel(agentId);
              if (entries.delete(agentId)) changed = true;
            }
          }
          continue;
        }
        if (isThinkingPresence(entry)) {
          const carried = expired.has(entry) ? undefined : carriedHolds.get(entry);
          const existing = entries.get(agentId);
          const candidate =
            carried !== undefined && carried.wakeupId === entry.wakeupId
              ? carried
              : existing !== undefined && existing.wakeupId === entry.wakeupId
                ? existing
                : undefined;
          if (candidate !== undefined && now < candidate.until) {
            holding.add(agentId);
            if (existing !== candidate) {
              entries.set(agentId, candidate);
              arm(agentId, candidate.until, now);
              changed = true;
            } else if (!timers.has(agentId)) {
              arm(agentId, candidate.until, now);
            }
          } else {
            cancel(agentId);
            const wasHolding = holding.delete(agentId);
            const hadCarried = carriedHolds.has(entry) && !expired.has(entry);
            expired.add(entry);
            if (entries.delete(agentId) || hadCarried) {
              changed = true;
              if (wasHolding || hadCarried) notify = true;
            }
          }
          continue;
        }
        cancel(agentId);
        holding.delete(agentId);
        if (entries.delete(agentId)) changed = true;
      }
      if (changed) {
        current = { entries: new Map(entries), expired };
        if (notify) notifyAll();
      }
    },
    snapshot() {
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      holding.clear();
      latest.clear();
      if (entries.size > 0) {
        entries.clear();
        current = { entries: new Map(), expired };
      }
    },
  };
}

function heldLineFor(
  entry: KinPresence,
  raw: KinPresenceLine,
  held: KinLabelHoldSnapshot | undefined,
): KinPresenceLine {
  if (held === undefined || !isThinkingPresence(entry) || held.expired.has(entry)) return raw;
  const kept = held.entries.get(entry.agentId) ?? carriedHolds.get(entry);
  if (kept === undefined || kept.wakeupId !== entry.wakeupId) return raw;
  return kept.line;
}

export interface KinWorkingLine {
  readonly presence: KinPresence;
  readonly line: KinPresenceLine;
  readonly stop: KinPresenceStop;
}

/**
 * The chat's working lines, one per agent with something to show, in the order their runs
 * started, so a label change never reorders them.
 */
export function kinWorkingLines(
  presence: ReadonlyArray<KinPresence>,
  now: number,
  mayStop: (agentId: string) => boolean,
  held?: KinLabelHoldSnapshot,
): ReadonlyArray<KinWorkingLine> {
  const rows = presence.flatMap((entry): Array<KinWorkingLine> => {
    const raw = kinPresenceLine(entry, now);
    if (raw === null) return [];
    return [
      {
        presence: entry,
        line: heldLineFor(entry, raw, held),
        stop: kinPresenceStop(entry, mayStop),
      },
    ];
  });
  // Hermes has no Array#toSorted; `rows` is this call's own array.
  return rows.sort(
    (a, b) =>
      a.presence.startedAt.localeCompare(b.presence.startedAt) ||
      a.presence.agentId.localeCompare(b.presence.agentId),
  );
}
