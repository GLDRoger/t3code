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
export const KIN_CHANGE_SENT_TEXT = "Sent. Your lead will ask what to change.";
export const KIN_SEND_FAILED_TEXT = "Couldn't send that. Try again.";

export type KinDeferralActionId = "change" | "remind";
export type KinDeferralPhase = "confirmed" | "closed";

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
    accessibilityLabel: "Change this deferral with your lead",
    tone: "secondary",
  },
  remind: {
    id: "remind",
    label: "Just remind me",
    accessibilityLabel: "Just remind me, don't start it",
    tone: "secondary",
  },
};

// Keyed by the resolved zone, so a device that changes timezone gets a fresh formatter.
const formatters = new Map<string, Intl.DateTimeFormat>();
function partsOf(ms: number, timeZone: string | undefined) {
  const zone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  let format = formatters.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, format);
  }
  return Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
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
export function kinDeferralCountdown(targetMs: number, nowMs: number): string {
  const remaining = targetMs - nowMs;
  return remaining <= 0 ? "Due now" : `Due in ${span(remaining)}`;
}

// Code writes this card, but its title comes from a memory item, so it is clamped as plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

const decodeDeferral = Schema.decodeUnknownOption(KinDeferralCard);
const isKinChatError = Schema.is(KinChatError);

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
      title,
      lines: ["Closed."],
      countdownTo: null,
      actions: [],
      accessibilityLabel: `Deferral: ${title}. Closed.`,
    };
  }

  const summary = `Deferred to ${formatKinDeferralTime(dueMs, timeZone)}. ${then[card.onDue]}`;
  // The host writes `text` in the owner's zone; show it only when it adds to the local summary.
  const text = clamp(card.text, 280);
  const lines = text === "" || text === summary ? [summary] : [summary, text];
  return {
    ...base,
    phase: "confirmed",
    title,
    lines,
    countdownTo: dueMs,
    // "Just remind me" changes nothing on a deferral that already only reminds.
    actions: card.onDue === "remind" ? [ACTIONS.change] : [ACTIONS.change, ACTIONS.remind],
    accessibilityLabel: [`Deferral: ${title}`, ...lines].join(". "),
  };
}

type KinCardTarget = Pick<KinDeferralCardView, "widgetId" | "revision" | "itemId">;

/** The one structured action a tap posts. Both actions carry only the item id (TRIG-7). */
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
export function kinActionFailureNotice(cause: unknown): KinCardNotice {
  if (!isKinChatError(cause)) return { kind: "error", text: KIN_SEND_FAILED_TEXT };
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

export type KinActionOutcome =
  | { readonly status: "ignored" }
  | { readonly status: "sent" }
  | { readonly status: "failed"; readonly notice: KinCardNotice };

/**
 * Posts card taps one at a time: a tap while another is in flight is ignored, so a double
 * tap posts once. Retrying the same action on the same revision after a transport failure
 * reuses its `clientActionId`, since the host may have taken the first send.
 */
export function createKinCardActions(options: {
  readonly post: (
    input: KinWidgetsActInput,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly cause: unknown }>;
  readonly newId: () => string;
}) {
  let busy = false;
  let unsettled: { readonly key: string; readonly clientActionId: string } | null = null;
  return async (
    view: KinCardTarget,
    actionId: KinDeferralActionId,
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
      const result = await options.post(kinDeferralActInput(view, actionId, clientActionId));
      if (result.ok) return { status: "sent" };
      return isKinChatError(result.cause)
        ? { status: "failed", notice: kinActionFailureNotice(result.cause) }
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

/**
 * Change writes nothing on the host, so the card stays usable after it. Remind re-arms and
 * bumps the card, so the buttons hold until that new revision arrives.
 */
export function kinCardStatusAfter(
  outcome: Exclude<KinActionOutcome, { readonly status: "ignored" }>,
  actionId: KinDeferralActionId,
  revision: number,
): KinCardStatus {
  if (outcome.status === "failed") return { revision, notice: outcome.notice, holding: false };
  return actionId === "change"
    ? { revision, notice: { kind: "sent", text: KIN_CHANGE_SENT_TEXT }, holding: false }
    : { revision, notice: { kind: "sent", text: KIN_SENT_CARD_TEXT }, holding: true };
}

/** A status raised on an older revision no longer describes the card. */
export function visibleKinCardStatus(
  status: KinCardStatus | null,
  revision: number,
): KinCardStatus | null {
  return status !== null && status.revision === revision ? status : null;
}
