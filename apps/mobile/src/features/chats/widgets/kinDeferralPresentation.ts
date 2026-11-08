import {
  KinChatError,
  KinDeferralCard,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const KIN_STALE_CARD_TEXT = "This card changed. Check it again.";
export const KIN_SENT_CARD_TEXT = "Sent. Your lead will update this card.";

export type KinDeferralActionId = "change" | "remind" | "start" | "monday" | "cancel";
export type KinDeferralPhase = "confirmed" | "heads_up" | "closed";

export interface KinDeferralAction {
  readonly id: KinDeferralActionId;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly tone: "primary" | "secondary" | "danger";
}

export interface KinDeferralCardView {
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  readonly itemId: string;
  readonly phase: KinDeferralPhase;
  readonly eyebrow: string;
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  /** Epoch ms the countdown runs to; null when the card is closed. */
  readonly countdownTo: number | null;
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

const ACTIONS: Record<KinDeferralActionId, KinDeferralAction> = {
  change: {
    id: "change",
    label: "Change",
    accessibilityLabel: "Change when this happens",
    tone: "secondary",
  },
  remind: {
    id: "remind",
    label: "Just remind me",
    accessibilityLabel: "Just remind me, don't start it",
    tone: "secondary",
  },
  start: { id: "start", label: "Start now", accessibilityLabel: "Start now", tone: "primary" },
  monday: {
    id: "monday",
    label: "Monday",
    accessibilityLabel: "Move it to Monday",
    tone: "secondary",
  },
  cancel: { id: "cancel", label: "Cancel", accessibilityLabel: "Cancel deferral", tone: "danger" },
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsOf(ms: number, timeZone: string | undefined) {
  const key = timeZone ?? "";
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(key, format);
  }
  return Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
}

/** "9:00" in the device timezone, or `timeZone` when given. */
export function formatKinClock(ms: number, timeZone?: string): string {
  const parts = partsOf(ms, timeZone);
  return `${Number(parts.hour)}:${parts.minute}`;
}

/** "Fri 13 Nov, 9:00" in the device timezone, or `timeZone` when given. */
export function formatKinDeferralTime(ms: number, timeZone?: string): string {
  const parts = partsOf(ms, timeZone);
  return `${parts.weekday} ${parts.day} ${parts.month}, ${Number(parts.hour)}:${parts.minute}`;
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

/** The countdown line. `nowMs` comes from the minute tick, so this changes at most once a minute. */
export function kinDeferralCountdown(
  phase: Exclude<KinDeferralPhase, "closed">,
  targetMs: number,
  nowMs: number,
): string {
  const remaining = targetMs - nowMs;
  if (phase === "heads_up")
    return remaining <= 0 ? "Starting now" : `Starts in ${span(remaining)} unless you stop it`;
  return remaining <= 0 ? "Due now" : `Due in ${span(remaining)}`;
}

// Code writes this card, but its title comes from a memory item, so it is clamped as plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

const decodeDeferral = Schema.decodeUnknownOption(KinDeferralCard);

export function kinDeferralCardView(
  widget: KinWidget,
  /** The device timezone when omitted; tests pass one. */
  timeZone?: string,
): KinDeferralCardView | null {
  const decoded = decodeDeferral(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const dueMs = Date.parse(card.dueAt);
  const title = clamp(card.title, 200) || "This deferral";
  const base = { widgetId: widget.widgetId, revision: widget.revision, itemId: card.itemId };

  if (widget.closedAt !== null) {
    return {
      ...base,
      phase: "closed",
      eyebrow: "Deferral",
      title,
      lines: ["Closed."],
      countdownTo: null,
      actions: [],
      accessibilityLabel: `Deferral: ${title}. Closed.`,
    };
  }

  if (card.phase === "heads_up") {
    const graceMs = card.graceEndsAt === undefined ? null : Date.parse(card.graceEndsAt);
    const startMs = graceMs ?? dueMs;
    const lines = [
      ...(graceMs === null ? [] : [`This was due at ${formatKinClock(dueMs, timeZone)}.`]),
      ...(card.recheck === undefined || clamp(card.recheck, 280) === ""
        ? []
        : [clamp(card.recheck, 280)]),
    ];
    const heading = `Starting ${title} at ${formatKinClock(startMs, timeZone)}`;
    return {
      ...base,
      phase: "heads_up",
      eyebrow: "Starting soon",
      title: heading,
      lines,
      countdownTo: startMs,
      actions: [ACTIONS.start, ACTIONS.monday, ACTIONS.cancel],
      accessibilityLabel: [heading, ...lines].join(". "),
    };
  }

  const summary = `Deferred to ${formatKinDeferralTime(dueMs, timeZone)}. ${then[card.onDue]}`;
  return {
    ...base,
    phase: "confirmed",
    eyebrow: "Deferral",
    title,
    lines: [summary],
    countdownTo: dueMs,
    // "Just remind me" changes nothing on a deferral that already only reminds.
    actions: card.onDue === "remind" ? [ACTIONS.change] : [ACTIONS.change, ACTIONS.remind],
    accessibilityLabel: `Deferral: ${title}. ${summary}`,
  };
}

export type KinDeferralTap =
  | { readonly id: "change"; readonly dueAt: string }
  | { readonly id: Exclude<KinDeferralActionId, "change"> };

/** The one structured action a tap posts. Change carries the owner's new time for the lead. */
export function kinDeferralActInput(
  view: Pick<KinDeferralCardView, "widgetId" | "revision" | "itemId">,
  tap: KinDeferralTap,
  clientActionId: string,
): KinWidgetsActInput {
  return {
    widgetId: view.widgetId,
    revision: view.revision,
    actionId: tap.id,
    value: tap.id === "change" ? { itemId: view.itemId, dueAt: tap.dueAt } : view.itemId,
    clientActionId,
  };
}

export type KinCardNotice = { readonly kind: "stale" | "error"; readonly text: string };

/** What the card says when the host refuses an action. */
export function kinActionFailureNotice(cause: unknown): KinCardNotice {
  if (cause instanceof KinChatError) {
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
        return { kind: "error", text: "Couldn't send that. Try again." };
    }
  }
  return {
    kind: "error",
    text:
      cause instanceof Error && cause.message ? cause.message : "Couldn't send that. Try again.",
  };
}

export type KinActionOutcome =
  | { readonly status: "ignored" }
  | { readonly status: "sent" }
  | { readonly status: "failed"; readonly notice: KinCardNotice };

/**
 * Posts card taps one at a time: a tap while another is in flight is ignored, so a double
 * tap posts once. Each accepted tap gets a fresh `clientActionId`.
 */
export function createKinCardActions(options: {
  readonly post: (
    input: KinWidgetsActInput,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly cause: unknown }>;
  readonly newId: () => string;
}) {
  let busy = false;
  return async (
    view: Pick<KinDeferralCardView, "widgetId" | "revision" | "itemId">,
    tap: KinDeferralTap,
    /** Runs only for an accepted tap, before it posts. */
    onStart?: () => void,
  ): Promise<KinActionOutcome> => {
    if (busy) return { status: "ignored" };
    busy = true;
    try {
      onStart?.();
      const result = await options.post(kinDeferralActInput(view, tap, options.newId()));
      return result.ok
        ? { status: "sent" }
        : { status: "failed", notice: kinActionFailureNotice(result.cause) };
    } catch (cause) {
      return { status: "failed", notice: kinActionFailureNotice(cause) };
    } finally {
      busy = false;
    }
  };
}
