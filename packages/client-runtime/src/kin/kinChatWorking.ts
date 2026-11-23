import {
  KinTaskCardState,
  type KinAgentId,
  type KinChatId,
  type KinChatWorkingResult,
  type KinMessage,
  type KinPresence,
  type KinWakeupId,
  type KinWidget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { kinPresenceLine } from "./kinLive.ts";

/** Where a row in "Working now" leads: the chat's end, a card in it, or another chat. */
export type KinWorkingOpen =
  | { readonly kind: "end" }
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "chat"; readonly chatId: KinChatId };

/** One thing working for the chat on screen. */
export interface KinWorkingItem {
  readonly key: string;
  readonly kind: "agent" | "handoff" | "worker";
  /** The pebble's agent; null for a worker. */
  readonly agentId: KinAgentId | null;
  readonly name: string;
  /** What it is doing, in a few words; null when nothing more is known. */
  readonly doing: string | null;
  readonly state: string;
  /** Paused, waiting for budget, silent or not started: the pill shows a warning, not a spinner. */
  readonly held: boolean;
  /** When it started, for the elapsed time; null when unknown. */
  readonly since: string | null;
  /** The wake-up a stop ends; null where nothing can stop it. */
  readonly wakeupId: KinWakeupId | null;
  readonly open: KinWorkingOpen | null;
}

const isTaskState = Schema.is(KinTaskCardState);

const PRESENCE_STATE: Record<
  Exclude<KinPresence["state"], "seen" | "stalled">,
  { readonly state: string; readonly held: boolean }
> = {
  starting: { state: "Starting", held: false },
  thinking: { state: "Working", held: false },
  working: { state: "Working", held: false },
  writing: { state: "Working", held: false },
  paused: { state: "Paused", held: true },
  deferred: { state: "Waiting for budget", held: true },
};

export const KIN_WORKING_COPY = {
  title: "Working now",
  agentFallback: "An agent",
  worker: "Worker",
  waitingToStart: "Waiting to start",
  openHint: "Shows what is working for this chat",
  stop: "Stop",
  stopping: "Stopping…",
  stopFailed: "Couldn't stop it.",
  alreadyDone: "It had already finished.",
  stopTitle: (name: string) => `Stop ${name}?`,
  stopMessage: "It stops where it is. Anything it already did stays.",
} as const;

/**
 * What is working for one chat: its agents' turns here, agents its messages were handed to, and
 * the workers its task cards track. Agents come first, then hand-offs, then workers.
 */
export function kinChatWorkingItems(input: {
  readonly presence: ReadonlyArray<KinPresence>;
  readonly widgets: ReadonlyArray<KinWidget>;
  readonly messages: ReadonlyArray<KinMessage>;
  readonly handoffs: KinChatWorkingResult["handoffs"];
  /** Chats the live chat list says are working. */
  readonly workingChats: ReadonlyArray<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly now: number;
}): ReadonlyArray<KinWorkingItem> {
  const name = (agentId: string) =>
    input.agentNames.get(agentId)?.trim() || KIN_WORKING_COPY.agentFallback;
  const agents = input.presence.flatMap((presence): ReadonlyArray<KinWorkingItem> => {
    if (presence.state === "seen") return [];
    const label = presence.label?.trim() || null;
    const shown =
      presence.state === "stalled"
        ? { state: kinPresenceLine(presence, input.now)?.text ?? "No output", held: true }
        : PRESENCE_STATE[presence.state];
    return [
      {
        key: `agent:${presence.agentId}`,
        kind: "agent",
        agentId: presence.agentId,
        name: name(presence.agentId),
        doing: presence.state === "stalled" ? null : label,
        ...shown,
        since: presence.startedAt,
        wakeupId: presence.wakeupId,
        open: { kind: "end" },
      },
    ];
  });
  // A turn's line ends before its wake-up is marked done, so a read made then still says running.
  const ended = (handoff: KinChatWorkingResult["handoffs"][number]) =>
    handoff.state === "running" &&
    handoff.chatId !== null &&
    !input.workingChats.includes(handoff.chatId);
  const handoffs = input.handoffs.flatMap((handoff): ReadonlyArray<KinWorkingItem> =>
    ended(handoff)
      ? []
      : [
          {
            key: `handoff:${handoff.agentId}:${handoff.wakeupId ?? handoff.since}`,
            kind: "handoff",
            agentId: handoff.agentId,
            name: name(handoff.agentId),
            doing: handoff.asked.trim() || null,
            state: handoff.state === "running" ? "Working" : KIN_WORKING_COPY.waitingToStart,
            held: handoff.state === "queued",
            since: handoff.since,
            wakeupId: handoff.wakeupId,
            open: handoff.chatId === null ? null : { kind: "chat", chatId: handoff.chatId },
          },
        ],
  );
  const created = new Map(input.messages.map((message) => [message.messageId, message.createdAt]));
  const workers = input.widgets.flatMap((widget): ReadonlyArray<KinWorkingItem> => {
    if (widget.type !== "task" || widget.closedAt !== null) return [];
    if (!isTaskState(widget.state) || widget.state.status !== "working") return [];
    return [
      {
        key: `worker:${widget.widgetId}`,
        kind: "worker",
        agentId: null,
        name: KIN_WORKING_COPY.worker,
        doing: widget.state.title.trim() || null,
        state: "Working",
        held: false,
        since: created.get(widget.messageId) ?? null,
        // Kin has no stop for a delegated task.
        wakeupId: null,
        open: { kind: "message", messageId: widget.messageId },
      },
    ];
  });
  return [...agents, ...handoffs, ...workers];
}

/** The pill's words; null when nothing is working. Never names a provider or model. */
export function kinWorkingPillLabel(items: ReadonlyArray<KinWorkingItem>): string | null {
  const [first] = items;
  if (first === undefined) return null;
  const named = items.find((item) => item.kind !== "worker");
  if (named === undefined)
    return items.length === 1 ? "Waiting on a worker" : `Waiting on ${items.length} workers`;
  if (items.length > 1) return `${named.name} and ${items.length - 1} more are working`;
  if (named.kind === "handoff")
    return named.held ? `Waiting on ${named.name}` : `${named.name} is working`;
  switch (named.state) {
    case "Working":
      return `${named.name} is working`;
    case "Starting":
      return `${named.name} is starting`;
    case "Paused":
      return `${named.name} is paused`;
    case "Waiting for budget":
      return `${named.name} is waiting for budget`;
    default:
      return `${named.name}: ${named.state.toLowerCase()}`;
  }
}

/** Whether this person may stop the item: the host lets them interrupt, and it has a wake-up. */
export const kinWorkingStoppable = (item: KinWorkingItem, canInterrupt: boolean) =>
  canInterrupt && item.wakeupId !== null;

/** The pill offers Stop only when the one thing working can be stopped. */
export function kinWorkingPillStop(
  items: ReadonlyArray<KinWorkingItem>,
  canInterrupt: boolean,
): KinWorkingItem | null {
  const [only] = items;
  return items.length === 1 && only !== undefined && kinWorkingStoppable(only, canInterrupt)
    ? only
    : null;
}

/** Changes when a hand-off may have started or ended, so the screen reads `kin.chat.working` again. */
export function kinWorkingRereadKey(input: {
  readonly presence: ReadonlyArray<KinPresence>;
  readonly workingChats: ReadonlyArray<string>;
}): string {
  const turns = input.presence.map((presence) => `${presence.agentId}:${presence.wakeupId}`);
  return [...turns.sort(), "|", ...[...input.workingChats].sort()].join(",");
}
