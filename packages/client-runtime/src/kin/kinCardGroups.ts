import { KinTaskCardState, type KinWidget } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { KinFeedRow } from "./kinChatFeed.ts";
import { kinChoiceCardView } from "./kinChoicePresentation.ts";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;

/**
 * Cards that read as one: an answered question and the tasks its answer started, or tasks posted
 * one after another. `key` is the first card's row key; `head` is that row's own.
 */
export interface KinCardGroupRow {
  readonly type: "cards";
  readonly key: string;
  readonly first: MessageRow;
  readonly question: MessageRow | null;
  readonly tasks: ReadonlyArray<MessageRow>;
}

const isTaskState = Schema.is(KinTaskCardState);

/**
 * An agent's card. The group's first row is drawn whole, its words above the card; a card that
 * joins it must have nothing else on its row (words, files, refs, an edit, a receipt) to lose.
 */
function agentCard(row: KinFeedRow, widgets: ReadonlyMap<string, KinWidget>, joins: boolean) {
  if (row.type !== "message" || row.own) return null;
  const { message } = row;
  if (message.author._tag !== "agent" || message.status !== "posted" || message.widgetId === null)
    return null;
  if (
    joins &&
    (message.body.trim() !== "" ||
      message.editedAt !== null ||
      (message.attachments ?? []).length > 0 ||
      (message.refs ?? []).length > 0 ||
      (message.turnChanges?.count ?? 0) > 0)
  )
    return null;
  const widget = widgets.get(message.widgetId);
  return widget === undefined || widget.widgetClass !== "native" ? null : { row, widget };
}

const agentOf = (row: MessageRow) =>
  row.message.author._tag === "agent" ? row.message.author.agentId : null;

const isTask = (widget: KinWidget) => widget.type === "task" && isTaskState(widget.state);

// An answered plain question; a mail or a picture keeps its own card.
function answeredQuestion(widget: KinWidget) {
  if (widget.type !== "choice") return false;
  const view = kinChoiceCardView(widget);
  return (
    view !== null &&
    (view.answer !== null || view.outcome !== null) &&
    view.send === null &&
    view.image === null
  );
}

const groups = new WeakMap<MessageRow, KinCardGroupRow>();

function groupRow(question: MessageRow | null, tasks: ReadonlyArray<MessageRow>) {
  const first = question ?? tasks[0]!;
  const held = groups.get(first);
  if (
    held !== undefined &&
    held.question === question &&
    held.tasks.length === tasks.length &&
    held.tasks.every((task, index) => task === tasks[index])
  )
    return held;
  const row: KinCardGroupRow = { type: "cards", key: `cards:${first.key}`, first, question, tasks };
  groups.set(first, row);
  return row;
}

/**
 * Feed rows with cards that belong together drawn as one. An answered question followed only by
 * task cards from the same agent becomes one card; so do consecutive task cards, and a lone task
 * card is a group of one. `reacted` names messages with reactions: one of those never joins a
 * group it would not lead, so its reactions stay in sight. Unchanged groups keep their identity.
 */
export function kinGroupCardRows(
  rows: ReadonlyArray<KinFeedRow>,
  widgets: ReadonlyMap<string, KinWidget>,
  reacted: ReadonlySet<string> = new Set(),
): ReadonlyArray<KinFeedRow | KinCardGroupRow> {
  const out: Array<KinFeedRow | KinCardGroupRow> = [];
  for (let index = 0; index < rows.length;) {
    const lead = agentCard(rows[index]!, widgets, false);
    const question = lead !== null && answeredQuestion(lead.widget) ? lead.row : null;
    if (lead === null || (question === null && !isTask(lead.widget))) {
      out.push(rows[index]!);
      index += 1;
      continue;
    }
    const agent = agentOf(lead.row);
    const tasks: Array<MessageRow> = question === null ? [lead.row] : [];
    let end = index + 1;
    while (end < rows.length) {
      const next = agentCard(rows[end]!, widgets, true);
      if (
        next === null ||
        !isTask(next.widget) ||
        agentOf(next.row) !== agent ||
        reacted.has(next.row.message.messageId)
      )
        break;
      tasks.push(next.row);
      end += 1;
    }
    if (tasks.length === 0) {
      out.push(rows[index]!);
      index += 1;
      continue;
    }
    out.push(groupRow(question, tasks));
    index = end;
  }
  return out;
}
