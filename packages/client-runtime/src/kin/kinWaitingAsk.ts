// @effect-diagnostics globalDate:off - Pure view helpers read the device's clock for React render, outside an Effect runtime.
import { formatKinWhen } from "@t3tools/contracts";
import type { KinWaitingItem, KinWidgetId } from "@t3tools/contracts";

export interface KinWaitingAskView {
  /** What a tap names: the card it answers, as `kinChoiceActInput` takes it. */
  readonly target: { readonly widgetId: KinWidgetId; readonly revision: number };
  /** "Finance goes with “Draft it” on Wednesday unless you say otherwise." */
  readonly line: string;
  readonly options: ReadonlyArray<{
    readonly optionId: string;
    readonly label: string;
    readonly isDefault: boolean;
  }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "today", "tomorrow", "on Wednesday", "on Wed 3 Dec", on the device's clock. */
function kinAskDay(atMs: number, nowMs: number): string {
  const start = (ms: number) => {
    const day = new Date(ms);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  };
  const days = Math.round((start(atMs) - start(nowMs)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  const at = new Date(atMs);
  return days <= 6
    ? `on ${formatKinWhen(at, "weekday")}`
    : `on ${formatKinWhen(at, "day").replace(/,/g, "")}`;
}

/**
 * An agent's open question in Waiting on you: what it does on which day unless answered, and its
 * answers to tap in place. Null for any other waiting item, or one from a host without it.
 */
export function kinWaitingAskView(item: KinWaitingItem, nowMs: number): KinWaitingAskView | null {
  const ask = item.ask;
  if (ask === undefined || item.widgetId === null) return null;
  const by = Date.parse(ask.by);
  const line =
    ask.default === null
      ? `${ask.agent} won't act on this without you.`
      : `${ask.agent} goes with “${ask.default}” ${kinAskDay(by, nowMs)} unless you say otherwise.`;
  return {
    target: { widgetId: item.widgetId, revision: ask.revision },
    line,
    options: ask.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      isDefault: option.label === ask.default,
    })),
  };
}

/**
 * The line under an open question card that Kin answers itself if nobody does: "If nobody answers
 * by tomorrow at 7:30 PM: Draft it." Read from the reader's own waiting item, which says what is
 * taken and when; null where none waits on that card or nothing is taken without them.
 */
export function kinChoiceDefaultLine(
  widgetId: KinWidgetId,
  waiting: ReadonlyArray<KinWaitingItem> | null | undefined,
  nowMs: number,
): string | null {
  const ask = waiting?.find((item) => item.widgetId === widgetId)?.ask;
  if (ask === undefined || ask.default === null) return null;
  const by = Date.parse(ask.by);
  // Past its time and not yet taken (the agent is paused, or Kin's next pass is due): no promise.
  if (by <= nowMs) return null;
  const day = kinAskDay(by, nowMs).replace(/^on /, "");
  const label = /[.!?…]$/u.test(ask.default) ? ask.default : `${ask.default}.`;
  return `If nobody answers by ${day} at ${formatKinWhen(new Date(by), "time")}: ${label}`;
}
