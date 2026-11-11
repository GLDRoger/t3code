import {
  KinChatError,
  KinDeferralCard,
  type KinReminderCardAction,
  type KinScheduledTaskCardAction,
  type KinWorkerPublishCardAction,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinSentences } from "./kinScreenState.ts";

export const KIN_STALE_CARD_TEXT = "This card changed. Check it again.";
export const KIN_SENT_CARD_TEXT = "Sent. Your lead will update this card.";
export const KIN_CHANGE_SENT_TEXT = "Sent. Your lead will ask what to change.";
export const KIN_SEND_FAILED_TEXT = "Couldn't send that. Try again.";
const KIN_UNDONE_TEXT = "Undone. Kin won't act on this.";
export const KIN_UNDO_TOO_LATE_TEXT = "Too late to undo: Kin already acted on this.";

/** The ids the host takes for each phase (`actionsFor` in the server's deferrals). */
export type KinDeferralActionId =
  | "undo"
  | "change"
  | "remind"
  | "start_now"
  | "monday"
  | "cancel"
  | KinReminderCardAction
  | KinScheduledTaskCardAction
  | KinWorkerPublishCardAction;
export type KinDeferralPhase =
  | "confirmed"
  | "heads_up"
  | "asked"
  | "started"
  | "closed"
  | "reminder"
  | "scheduled";

export interface KinDeferralAction {
  readonly id: KinDeferralActionId;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly tone: "secondary";
}

export interface KinDeferralCardView {
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  readonly itemId: string;
  readonly phase: KinDeferralPhase;
  /** The small line above the title. */
  readonly eyebrow: string;
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  /** What the countdown runs to; null when nothing is pending. */
  readonly countdown: { readonly to: number; readonly kind: KinCountdownKind } | null;
  readonly actions: ReadonlyArray<KinDeferralAction>;
  /** The card's label without the countdown, which reads from its own line. */
  readonly accessibilityLabel: string;
}

const then: Record<KinDeferralCard["onDue"], string> = {
  start: "I'll start then.",
  remind: "I'll remind you then.",
  ask: "I'll ask you then.",
  chase: "I'll chase it then.",
};

export const KIN_DEFERRAL_ACTIONS: Record<KinDeferralActionId, KinDeferralAction> = {
  undo: {
    id: "undo",
    label: "Undo",
    accessibilityLabel: "Undo this",
    tone: "secondary",
  },
  change: {
    id: "change",
    label: "Change",
    accessibilityLabel: "Change this with your lead",
    tone: "secondary",
  },
  remind: {
    id: "remind",
    label: "Just remind me",
    accessibilityLabel: "Just remind me, don't start it",
    tone: "secondary",
  },
  start_now: {
    id: "start_now",
    label: "Start now",
    accessibilityLabel: "Start this now",
    tone: "secondary",
  },
  monday: {
    id: "monday",
    label: "Monday",
    accessibilityLabel: "Move this to Monday at 9:00",
    tone: "secondary",
  },
  cancel: {
    id: "cancel",
    label: "Cancel",
    accessibilityLabel: "Cancel this",
    tone: "secondary",
  },
  done: {
    id: "done",
    label: "Done",
    accessibilityLabel: "Mark this reminder done",
    tone: "secondary",
  },
  snooze_10m: {
    id: "snooze_10m",
    label: "Snooze 10 min",
    accessibilityLabel: "Snooze this reminder for 10 minutes",
    tone: "secondary",
  },
  snooze_1h: {
    id: "snooze_1h",
    label: "Snooze 1 h",
    accessibilityLabel: "Snooze this reminder for an hour",
    tone: "secondary",
  },
  snooze_tomorrow: {
    id: "snooze_tomorrow",
    label: "Tomorrow 9:00",
    accessibilityLabel: "Snooze this reminder to tomorrow at 9:00",
    tone: "secondary",
  },
  run_now: {
    id: "run_now",
    label: "Run now",
    accessibilityLabel: "Run this scheduled task now",
    tone: "secondary",
  },
  pause: {
    id: "pause",
    label: "Pause",
    accessibilityLabel: "Pause this scheduled task",
    tone: "secondary",
  },
  resume: {
    id: "resume",
    label: "Resume",
    accessibilityLabel: "Resume this scheduled task",
    tone: "secondary",
  },
  edit: {
    id: "edit",
    label: "Edit",
    accessibilityLabel: "Edit this scheduled task with your lead",
    tone: "secondary",
  },
  delete: {
    id: "delete",
    label: "Delete",
    accessibilityLabel: "Delete this scheduled task",
    tone: "secondary",
  },
  publish: {
    id: "publish",
    label: "Publish",
    accessibilityLabel: "Publish these changes to GitHub",
    tone: "secondary",
  },
  dont_publish: {
    id: "dont_publish",
    label: "Don't publish",
    accessibilityLabel: "Don't publish these changes",
    tone: "secondary",
  },
};

const DECISION_ACTIONS = [
  KIN_DEFERRAL_ACTIONS.start_now,
  KIN_DEFERRAL_ACTIONS.monday,
  KIN_DEFERRAL_ACTIONS.cancel,
];

// Whole formatted strings only: Hermes leaves out `hour` and `minute` from `formatToParts`.
const formatters = new Map<string, { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }>();
function formattersFor(timeZone: string | undefined) {
  // Keyed by the resolved zone, so a device that changes timezone gets fresh formatters.
  const zone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  let held = formatters.get(zone);
  if (held === undefined) {
    held = {
      date: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
      time: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    };
    formatters.set(zone, held);
  }
  return held;
}

/** "9:00" in the device timezone, or `timeZone` when given. */
export function formatKinDeferralClock(ms: number, timeZone?: string): string {
  return formattersFor(timeZone)
    .time.format(ms)
    .replace(/^0(?=\d)/, "");
}

/** "Fri 13 Nov, 9:00" in the device timezone, or `timeZone` when given. */
export function formatKinDeferralTime(ms: number, timeZone?: string): string {
  return `${formattersFor(timeZone).date.format(ms)}, ${formatKinDeferralClock(ms, timeZone)}`;
}

const MINUTE = 60_000;
function span(ms: number): string {
  const minutes = Math.ceil(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return rest === 0
      ? `${Math.floor(minutes / 60)} h`
      : `${Math.floor(minutes / 60)} h ${rest} min`;
  }
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? "1 day" : `${days} days`;
}

/** "due" counts down to the due time; "start" to when a heads-up card starts the work; "run" to a scheduled task's next run. */
export type KinCountdownKind = "due" | "start" | "run";

/** The countdown line. `nowMs` comes from the minute tick, so this changes at most once a minute. */
export function kinDeferralCountdown(
  targetMs: number,
  nowMs: number,
  kind: KinCountdownKind = "due",
): string {
  const remaining = targetMs - nowMs;
  if (kind === "run") return remaining <= 0 ? "Running soon" : `Next run in ${span(remaining)}`;
  const verb = kind === "due" ? "Due" : "Starting";
  return remaining <= 0 ? `${verb} now` : `${verb} in ${span(remaining)}`;
}

// Code writes this card, but its title comes from a memory item, so it is clamped as plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

const decodeDeferral = Schema.decodeUnknownOption(KinDeferralCard);
const isKinChatError = Schema.is(KinChatError);

type CardBody = Pick<KinDeferralCardView, "phase" | "lines" | "countdown" | "actions">;

function cardBody(card: KinDeferralCard, timeZone: string | undefined): CardBody {
  const dueMs = Date.parse(card.dueAt);
  // The host writes `text` in the owner's zone; show it only when it adds to the local lines.
  const text = clamp(card.text, 280);
  // Older hosts wrote "Deferred to …" as the text, which the local line already says.
  const withText = (lines: ReadonlyArray<string>) =>
    text === "" || lines.includes(text) || text.startsWith("Deferred to ")
      ? lines
      : [...lines, text];
  switch (card.phase) {
    case undefined:
      return {
        phase: "confirmed",
        lines: withText([`Set for ${formatKinDeferralTime(dueMs, timeZone)}. ${then[card.onDue]}`]),
        countdown: { to: dueMs, kind: "due" },
        // The host takes only Undo here until its owner-tap dispatcher lands for Change and Just remind me.
        actions: [KIN_DEFERRAL_ACTIONS.undo],
      };
    case "heads_up": {
      // The host's text repeats the start time in the owner's zone, so the local lines replace it.
      const graceMs = card.graceEndsAt === undefined ? null : Date.parse(card.graceEndsAt);
      const startMs = graceMs ?? dueMs;
      const starting = `Starting at ${formatKinDeferralClock(startMs, timeZone)}.`;
      return {
        phase: "heads_up",
        lines:
          graceMs === null
            ? [starting]
            : [`This was due at ${formatKinDeferralClock(dueMs, timeZone)}.`, starting],
        countdown: { to: startMs, kind: "start" },
        actions: DECISION_ACTIONS,
      };
    }
    case "asked":
      // The host's text names what changed: why it won't start on its own, or that it's late.
      return {
        phase: "asked",
        lines:
          text === ""
            ? [
                `Due at ${formatKinDeferralTime(dueMs, timeZone)}. Start it, move it to Monday, or cancel it?`,
              ]
            : [text],
        countdown: null,
        actions: DECISION_ACTIONS,
      };
    case "started":
      return { phase: "started", lines: withText(["Started."]), countdown: null, actions: [] };
  }
}

export function kinDeferralCardView(
  widget: KinWidget,
  /** The device timezone when omitted; tests pass one. */
  timeZone?: string,
): KinDeferralCardView | null {
  const decoded = decodeDeferral(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const title = clamp(card.title, 200) || (card.onDue === "remind" ? "Reminder" : "Scheduled work");
  const body: CardBody =
    widget.closedAt === null
      ? cardBody(card, timeZone)
      : { phase: "closed", lines: ["Closed."], countdown: null, actions: [] };
  // "Deferral" is Kin's word, not the owner's: they asked for a reminder or for work to wait.
  const kind = card.onDue === "remind" ? "Reminder" : "Scheduled";
  const eyebrow = body.phase === "asked" ? "Needs your decision" : kind;
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    itemId: card.itemId,
    eyebrow,
    title,
    ...body,
    accessibilityLabel: kinSentences([`${kind}: ${title}`, ...body.lines]),
  };
}

/**
 * Kin's own note that it set something for later. False while the card asks for a decision,
 * which still needs its buttons.
 */
export function kinDeferralIsBookkeeping(widget: KinWidget): boolean {
  const decoded = decodeDeferral(widget.state);
  if (Option.isNone(decoded)) return false;
  const { phase } = decoded.value;
  return !(widget.closedAt === null && (phase === "heads_up" || phase === "asked"));
}

type KinCardTarget = Pick<KinDeferralCardView, "widgetId" | "revision" | "itemId">;

/** The one structured action a tap posts. Every action carries only the item id (TRIG-7, TRIG-8). */
export function kinDeferralActInput(
  view: KinCardTarget,
  actionId: KinDeferralActionId,
  clientActionId: string,
): KinWidgetsActInput {
  return {
    widgetId: view.widgetId,
    revision: view.revision,
    actionId,
    value: view.itemId,
    clientActionId,
  };
}

export type KinCardNotice = {
  readonly kind: "sent" | "stale" | "error";
  readonly text: string;
};

/** What the card says when the host refuses an action or the send fails. */
export function kinActionFailureNotice(
  cause: unknown,
  actionId?: KinDeferralActionId,
): KinCardNotice {
  if (!isKinChatError(cause)) return { kind: "error", text: KIN_SEND_FAILED_TEXT };
  if (actionId === "undo" && cause.reason === "invalid_state")
    return { kind: "stale", text: KIN_UNDO_TOO_LATE_TEXT };
  switch (cause.reason) {
    case "widget_changed":
      return { kind: "stale", text: KIN_STALE_CARD_TEXT };
    case "not_allowed":
      return {
        kind: "error",
        text: "Kin didn't take that answer. Tell your lead in the chat instead.",
      };
    case "invalid_state":
      return { kind: "error", text: "This card can't take that answer any more." };
    default:
      return { kind: "error", text: KIN_SEND_FAILED_TEXT };
  }
}

/** Why the host may refuse [Start now] (TRIG-8's `Deferrals.act`), in the owner's words. */
export const KIN_START_NOW_REFUSALS = {
  stopped: "Starts are paused for now. Ask your lead in the chat.",
  workers_blocked: "Kin can't start new work right now. Try again soon.",
  below_l2: "Your lead can't start work from here. Ask it in the chat.",
} as const satisfies Record<string, string>;

export function kinStartNowRefusalNotice(
  reason: keyof typeof KIN_START_NOW_REFUSALS,
): KinCardNotice {
  return { kind: "error", text: KIN_START_NOW_REFUSALS[reason] };
}

export type KinActionOutcome =
  | { readonly status: "ignored" }
  | { readonly status: "sent" }
  | { readonly status: "failed"; readonly notice: KinCardNotice };

/**
 * Posts card taps one at a time: a tap while another is in flight is ignored, so a double
 * tap posts once. Retrying the same action on the same revision after a transport failure
 * reuses its `clientActionId`, since the host may have taken the first send.
 */
export function createKinCardActions<
  Target extends Pick<KinWidgetsActInput, "widgetId" | "revision">,
  Action extends string,
>(options: {
  readonly post: (
    input: KinWidgetsActInput,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly cause: unknown }>;
  readonly newId: () => string;
  readonly toInput: (view: Target, actionId: Action, clientActionId: string) => KinWidgetsActInput;
  /** What a refusal says; the generic card text by default. */
  readonly failureNotice?: (cause: KinChatError, actionId: Action) => KinCardNotice;
}) {
  const failureNotice = options.failureNotice ?? ((cause) => kinActionFailureNotice(cause));
  let busy = false;
  let unsettled: { readonly key: string; readonly clientActionId: string } | null = null;
  return async (
    view: Target,
    actionId: Action,
    /** Runs only for an accepted tap, before it posts. */
    onStart?: () => void,
  ): Promise<KinActionOutcome> => {
    if (busy) return { status: "ignored" };
    busy = true;
    const key = `${view.widgetId}\u0000${view.revision}\u0000${actionId}`;
    const clientActionId = unsettled?.key === key ? unsettled.clientActionId : options.newId();
    unsettled = null;
    const transportFailure = (): KinActionOutcome => {
      unsettled = { key, clientActionId };
      return { status: "failed", notice: kinActionFailureNotice(undefined) };
    };
    try {
      onStart?.();
      const result = await options.post(options.toInput(view, actionId, clientActionId));
      if (result.ok) return { status: "sent" };
      return isKinChatError(result.cause)
        ? { status: "failed", notice: failureNotice(result.cause, actionId) }
        : transportFailure();
    } catch {
      return transportFailure();
    } finally {
      busy = false;
    }
  };
}

/** What a card shows after a tap, tied to the revision it was raised on. */
export interface KinCardStatus {
  readonly revision: number;
  readonly notice: KinCardNotice | null;
  /** True while the buttons wait for the host's next revision. */
  readonly holding: boolean;
}

// Kin finishes these taps itself, so the card says what happened rather than waiting on the lead.
const SERVER_DONE: Partial<Record<KinDeferralActionId, string>> = {
  done: "Done.",
  snooze_10m: "Snoozed.",
  snooze_1h: "Snoozed.",
  snooze_tomorrow: "Snoozed.",
  run_now: "Starting a run now.",
  pause: "Paused.",
  resume: "Resumed.",
  delete: "Deleted.",
  publish: "Publishing.",
  dont_publish: "Kin won't publish it.",
};

/**
 * Change and Edit write nothing on the host, so the card stays usable after them. Every other
 * action rewrites or closes the card, so the buttons hold until that new revision arrives.
 */
export function kinCardStatusAfter(
  outcome: Exclude<KinActionOutcome, { readonly status: "ignored" }>,
  actionId: KinDeferralActionId,
  revision: number,
): KinCardStatus {
  if (outcome.status === "failed") return { revision, notice: outcome.notice, holding: false };
  if (actionId === "change" || actionId === "edit")
    return { revision, notice: { kind: "sent", text: KIN_CHANGE_SENT_TEXT }, holding: false };
  const text =
    actionId === "undo" ? KIN_UNDONE_TEXT : (SERVER_DONE[actionId] ?? KIN_SENT_CARD_TEXT);
  return { revision, notice: { kind: "sent", text }, holding: true };
}

/** A status raised on an older revision no longer describes the card. */
export function visibleKinCardStatus(
  status: KinCardStatus | null,
  revision: number,
): KinCardStatus | null {
  return status !== null && status.revision === revision ? status : null;
}
