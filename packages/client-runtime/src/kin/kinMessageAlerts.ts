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
  /** The in-app notice's button, which opens what the message is about. */
  open: "Open",
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
  title: row.view.title ?? "Kin",
  body: row.author === null ? row.preview : `${row.author}: ${row.preview}`,
});

/**
 * How each arrival is told on this device: by the system while you are in another window, else
 * in the app, unless it is the chat already on screen.
 */
export function kinArrivalNotices(
  arrivals: ReadonlyArray<KinChatListRow>,
  where: { readonly looking: boolean; readonly onScreenChatId: string | null },
): {
  readonly system: ReadonlyArray<KinChatListRow>;
  readonly inApp: ReadonlyArray<KinChatListRow>;
} {
  if (!where.looking) return { system: arrivals, inApp: [] };
  return {
    system: [],
    inApp: arrivals.filter((row) => row.chat.chatId !== where.onScreenChatId),
  };
}
