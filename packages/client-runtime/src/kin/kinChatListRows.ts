import type { KinChatSummary } from "@t3tools/contracts";

import { KIN_RETIRED_LABEL, kinRetiredDirectAgentId } from "./kinAgentRetire.ts";
import { kinAttachmentSummary } from "./kinAttachments.ts";
import type { KinInboxView } from "./kinInboxModel.ts";
import {
  kinChatRowLabel,
  kinChatRowView,
  type KinChatRowView,
  type KinDirectory,
} from "./kinScreenState.ts";

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
  /** A direct chat whose agent is retired: kept to read, listed after everything else. */
  readonly retired: boolean;
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
  if (last.body.trim() === "" && last.attachments !== undefined)
    return kinAttachmentSummary(last.attachments);
  return view.preview;
}

/**
 * The chat list in one order: chats that wait on the viewer, then working ones, then the rest by
 * latest message, then chats nobody has written in yet, and a retired agent's chats last.
 */
export function kinChatListRows(
  inbox: KinInboxView,
  directory: KinDirectory,
): ReadonlyArray<KinChatListRow> {
  const rows = inbox.rows.map((row): KinChatListRow => {
    const view = kinChatRowView(row, directory);
    const retired = kinRetiredDirectAgentId(row.chat, directory.retiredAgents) !== null;
    const fresh = row.chat.lastMessage === null;
    return {
      chat: row.chat,
      view,
      author: view.author === "You" || row.chat.kind !== "direct" ? view.author : null,
      // Nobody is there to say hello to.
      preview: retired && fresh ? KIN_RETIRED_LABEL : previewOf(row.chat, view),
      needsYou: row.fold === "needsYou",
      working: row.chat.working === true,
      fresh,
      retired,
    };
  });
  const live = rows.filter((row) => !row.retired);
  const settled = (row: KinChatListRow) => row.fresh && !row.needsYou && !row.working;
  return [
    ...live.filter((row) => !settled(row)),
    ...live.filter(settled),
    ...rows.filter((row) => row.retired),
  ];
}

/** "Tech lead, agent. Payments test fixed. 9:30. 3 unread. Working." */
export function kinChatListRowLabel(row: KinChatListRow, time: (date: Date) => string): string {
  const label = kinChatRowLabel({ ...row.view, author: row.author, preview: row.preview }, time);
  return [
    label,
    row.retired && row.preview !== KIN_RETIRED_LABEL ? "Retired." : null,
    row.working ? "Working." : null,
    row.needsYou ? "Needs you." : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
}
