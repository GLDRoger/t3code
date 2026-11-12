import { kinChoiceCardView } from "@t3tools/client-runtime/kin/kinChoicePresentation";
import type { KinMessage, KinWidget } from "@t3tools/contracts";

const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Leads often post a choice card's question again as text beside it. A plain bubble from the
 * card's own author, next to the card, that says just the question adds nothing, so the feed
 * leaves it out. Server-side folding would be better; until then the client hides the echo.
 */
export function kinWithoutChoiceEchoes(
  messages: ReadonlyArray<KinMessage>,
  widgets: ReadonlyMap<string, KinWidget>,
): ReadonlyArray<KinMessage> {
  const question = (message: KinMessage | undefined) => {
    if (message === undefined || message.widgetId === null) return null;
    const widget = widgets.get(message.widgetId);
    if (widget === undefined || widget.type !== "choice") return null;
    const view = kinChoiceCardView(widget);
    return view === null ? null : normalized(view.question);
  };
  const echoes = (message: KinMessage, neighbour: KinMessage | undefined) =>
    neighbour !== undefined &&
    neighbour.author._tag === "agent" &&
    message.author._tag === "agent" &&
    neighbour.author.agentId === message.author.agentId &&
    question(neighbour) === normalized(message.body);
  const kept = messages.filter(
    (message, index) =>
      message.widgetId !== null ||
      message.status !== "posted" ||
      (message.attachments?.length ?? 0) > 0 ||
      !(echoes(message, messages[index - 1]) || echoes(message, messages[index + 1])),
  );
  return kept.length === messages.length ? messages : kept;
}
