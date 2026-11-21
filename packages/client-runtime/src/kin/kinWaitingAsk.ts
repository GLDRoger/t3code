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
