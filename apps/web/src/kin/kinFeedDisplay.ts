import type { KinFeedRow } from "@t3tools/client-runtime/kin/kinChatFeed";

export interface KinRowDisplay {
  /** An earlier copy of a notice the host repeated; only the last one is drawn. */
  readonly hidden: boolean;
  /** The line over a bubble: who (where it isn't obvious) and when (where it changed). */
  readonly head: string | null;
}

const PLAIN: KinRowDisplay = { hidden: false, head: null };
const HIDDEN: KinRowDisplay = { hidden: true, head: null };

/**
 * How each feed row is drawn, by row key. A direct chat names nobody over a bubble, since both
 * sides are known; a time shows once per minute, and not again right under a time divider.
 */
export function kinFeedDisplay(input: {
  readonly rows: ReadonlyArray<KinFeedRow>;
  readonly direct: boolean;
  readonly formatTime: (iso: string) => string;
}): ReadonlyMap<string, KinRowDisplay> {
  const display = new Map<string, KinRowDisplay>();
  let previousOwn = false;
  let previousBubble = false;
  // `null` right after a divider, which already shows the next message's time.
  let shownTime: string | null = "";
  let previousNotice: Extract<KinFeedRow, { readonly type: "system" }> | null = null;
  for (const row of input.rows) {
    if (row.type === "day") {
      shownTime = null;
      previousBubble = false;
      previousNotice = null;
      continue;
    }
    if (row.type === "system") {
      // The host repeats a notice on every failed retry; the last one stands for the run.
      if (previousNotice !== null && previousNotice.text === row.text) {
        display.set(previousNotice.key, HIDDEN);
      }
      previousNotice = row;
      previousBubble = false;
      continue;
    }
    previousNotice = null;
    if (row.type !== "message") {
      previousBubble = false;
      continue;
    }
    const starts = row.own ? !(previousBubble && previousOwn) : row.showAuthor || !previousBubble;
    previousBubble = true;
    previousOwn = row.own;
    if (!starts) {
      display.set(row.key, PLAIN);
      continue;
    }
    const time = input.formatTime(row.message.createdAt);
    const name = row.own || input.direct ? null : row.authorLabel;
    const parts = [name, shownTime === null || shownTime === time ? null : time].filter(
      (part) => part !== null,
    );
    shownTime = time;
    display.set(row.key, {
      hidden: false,
      head: parts.length === 0 ? null : parts.join(" · "),
    });
  }
  return display;
}
