import { kinCardView } from "@t3tools/client-runtime/kin/kinCardPresentation";
import type { KinFeedRow } from "@t3tools/client-runtime/kin/kinChatFeed";
import type { EnvironmentId, KinWidget } from "@t3tools/contracts";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;

export interface KinRowDisplay {
  /** A card tap: the card it answered already shows the answer, so the tap isn't drawn. */
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

const allKnown = () => true;

/**
 * What a row says when it is the host's old bookkeeping rather than conversation: a note about a
 * reminder it set or memory it changed. Newer hosts no longer post these.
 */
function kinQuietText(
  row: MessageRow,
  widget: KinWidget | undefined,
  environmentId: EnvironmentId,
): string | null {
  const { message } = row;
  if (message.status === "deleted") return null;
  if (message.author._tag !== "system" || widget === undefined) return null;
  const view = kinCardView(widget, environmentId, allKnown);
  if (view.kind === "memory_changes") {
    const [first, ...rest] = view.changes.items;
    if (first === undefined) return null;
    return rest.length === 0 ? first.line : `${first.line}, and ${rest.length} more`;
  }
  if (view.kind === "deferral" && view.deferral.phase === "confirmed") {
    return kinQuietWording(view.deferral.lines[0] ?? view.deferral.title);
  }
  return null;
}

/**
 * How each feed row is drawn, by row key. A direct chat names nobody over a bubble, since both
 * sides are known; a time shows once per minute, and not again right under a time divider.
 */
export function kinFeedDisplay(input: {
  readonly rows: ReadonlyArray<KinFeedRow>;
  readonly widgets: ReadonlyMap<string, KinWidget>;
  readonly environmentId: EnvironmentId;
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
    // A tap is stored as JSON, which must never be drawn; its card carries the answer.
    if (row.message.kind === "widget_action" && row.message.status !== "deleted") {
      display.set(row.key, HIDDEN);
      continue;
    }
    const quiet = kinQuietText(row, widget, input.environmentId);
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
