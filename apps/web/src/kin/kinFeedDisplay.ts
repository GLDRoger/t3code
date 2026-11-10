import { kinQuietCardLine } from "@t3tools/client-runtime/kin/kinCardPresentation";
import type { KinFeedRow } from "@t3tools/client-runtime/kin/kinChatFeed";
import type { KinWidget } from "@t3tools/contracts";

export interface KinRowDisplay {
  /** An earlier copy of a notice the host repeated; only the last one is drawn. */
  readonly hidden: boolean;
  /** Bookkeeping drawn as one muted line instead of a bubble or card; null draws the row as is. */
  readonly quiet: string | null;
  /** The line over a bubble: who (where it isn't obvious) and when (where it changed). */
  readonly head: string | null;
}

const PLAIN: KinRowDisplay = { hidden: false, quiet: null, head: null };
const HIDDEN: KinRowDisplay = { hidden: true, quiet: null, head: null };

/** History keeps the host's old wording; the owner never set a "deferral". */
export const kinQuietWording = (text: string) => text.replace(/^Deferred to /, "Scheduled for ");

/** The host's old notes to itself, as plain system rows: about memory, or a reminder it set. */
export const kinIsBookkeeping = (text: string) =>
  /^(Remembered|Forgot|Updated|Replaced|Memory): /.test(text) || text.startsWith("Deferred to ");

/**
 * How each feed row is drawn, by row key. A direct chat names nobody over a bubble, since both
 * sides are known; a time shows once per minute, and not again right under a time divider.
 */
export function kinFeedDisplay(input: {
  readonly rows: ReadonlyArray<KinFeedRow>;
  readonly widgets: ReadonlyMap<string, KinWidget>;
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
    const widget =
      row.message.widgetId === null ? undefined : input.widgets.get(row.message.widgetId);
    // The host's old notes about a reminder it set or memory it changed; newer hosts post none.
    const quiet =
      row.message.author._tag === "system" && row.message.status !== "deleted"
        ? kinQuietCardLine(widget)
        : null;
    if (quiet !== null) {
      display.set(row.key, { hidden: false, quiet, head: null });
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
      quiet: null,
      head: parts.length === 0 ? null : parts.join(" · "),
    });
  }
  return display;
}
