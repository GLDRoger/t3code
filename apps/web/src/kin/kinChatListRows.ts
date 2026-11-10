import type { KinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  kinChatRowView,
  type KinChatRowView,
  type KinDirectory,
} from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinChatSummary } from "@t3tools/contracts";

export interface KinChatListRow {
  readonly chat: KinChatSummary;
  readonly view: KinChatRowView;
  /** "You" in "You: on it"; a lead's name only where more than one could have written it. */
  readonly author: string | null;
  readonly preview: string;
  readonly needsYou: boolean;
  readonly working: boolean;
  /** Nobody has written here yet. */
  readonly fresh: boolean;
}

// A card posted without words has no body to preview, so its id's prefix says what it was.
const CARD_PREVIEWS: ReadonlyArray<readonly [prefix: string, preview: string]> = [
  ["choice:", "Asked you a question"],
  ["approval:", "Needs your approval"],
  ["task:", "Started a task"],
  ["reminder:", "Reminder"],
  ["scheduled:", "Scheduled task"],
];

function previewOf(chat: KinChatSummary, view: KinChatRowView): string {
  const last = chat.lastMessage;
  if (last === null) return "Say hello to get started";
  if (last.status === "deleted") return view.preview;
  if (last.body.trim() === "" && last.widgetId !== null) {
    const { widgetId } = last;
    return CARD_PREVIEWS.find(([prefix]) => widgetId.startsWith(prefix))?.[1] ?? "Sent a card";
  }
  return view.preview;
}

/**
 * The chat list in one order: chats that wait on the viewer, then working ones, then the rest by
 * latest message, with chats nobody has written in yet at the end.
 */
export function kinChatListRows(
  inbox: KinInboxView,
  directory: KinDirectory,
): ReadonlyArray<KinChatListRow> {
  const rows = inbox.rows.map((row): KinChatListRow => {
    const view = kinChatRowView(row, directory);
    return {
      chat: row.chat,
      view,
      author: view.author === "You" || row.chat.kind !== "direct" ? view.author : null,
      preview: previewOf(row.chat, view),
      needsYou: row.fold === "needsYou",
      working: row.chat.working === true,
      fresh: row.chat.lastMessage === null,
    };
  });
  const settled = (row: KinChatListRow) => row.fresh && !row.needsYou && !row.working;
  return [...rows.filter((row) => !settled(row)), ...rows.filter(settled)];
}
