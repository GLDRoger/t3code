import type { KinChatListRow } from "./kinChatListRows.ts";

/**
 * What a device that is open but not looked at alerts for: a chat whose unread count rose since
 * the last look. The first look alerts for nothing, so opening Kin doesn't replay old messages.
 */
export const KIN_MESSAGE_ALERTS = {
  title: "Notifications",
  detail:
    "Alerts on this computer when someone writes to you while Kin is open but you're in another window. Your phone's notifications are set on the phone.",
  label: "Message alerts",
};

export type KinUnreadSeen = ReadonlyMap<string, number>;

export const kinUnreadSeen = (rows: ReadonlyArray<KinChatListRow>): KinUnreadSeen =>
  new Map(rows.map((row) => [row.chat.chatId, row.view.unread]));

/** Chats with more unread than `seen` held, muted ones left out; none on the first look. */
export function kinNewArrivals(
  seen: KinUnreadSeen | null,
  rows: ReadonlyArray<KinChatListRow>,
): ReadonlyArray<KinChatListRow> {
  if (seen === null) return [];
  return rows.filter(
    (row) => !row.view.muted && row.view.unread > (seen.get(row.chat.chatId) ?? 0),
  );
}

/** One alert's words: the chat, and its last line with who wrote it. */
export const kinArrivalText = (row: KinChatListRow) => ({
  title: row.view.title,
  body: row.author === null ? row.preview : `${row.author}: ${row.preview}`,
});
