import type { KinDesktopNotice } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import type { KinChatListRow } from "./kinChatListRows.ts";
import { kinNotificationDestination } from "./kinNotificationDestination.ts";

export function kinDefaultNotificationMode(input: {
  readonly kinWebOnly: boolean;
  readonly inKinDesktopWindow: boolean;
}): ClientSettings["notificationMode"] {
  return input.kinWebOnly || input.inKinDesktopWindow ? "notifications-and-sound" : "off";
}

export type KinAlertPermission = "granted" | "denied" | "default" | "insecure";

export function kinAlertSettingsNotice(input: {
  readonly mode: ClientSettings["notificationMode"];
  readonly permission: KinAlertPermission;
  readonly desktop: boolean;
}): {
  readonly status: string | null;
  readonly problem: string | null;
  readonly canAsk: boolean;
} {
  if (input.mode === "off" || input.mode === "sound" || input.permission === "granted") {
    return { status: null, problem: null, canAsk: false };
  }
  if (input.permission === "insecure") {
    return { status: null, problem: KIN_MESSAGE_ALERTS.needsSecure, canAsk: false };
  }
  if (input.permission === "denied") {
    return {
      status: KIN_MESSAGE_ALERTS.blockedStatus,
      problem: input.desktop ? KIN_MESSAGE_ALERTS.blockedDesktop : KIN_MESSAGE_ALERTS.blocked,
      canAsk: false,
    };
  }
  return { status: null, problem: null, canAsk: true };
}

export function kinDesktopNoticeShows(
  notice: Pick<KinDesktopNotice, "ring">,
  {
    looking,
    mode,
  }: { readonly looking: boolean; readonly mode: ClientSettings["notificationMode"] },
): { readonly banner: boolean; readonly sound: boolean } | null {
  if (looking || mode === "off") return null;
  return {
    banner: mode === "notifications" || mode === "notifications-and-sound",
    sound: notice.ring && (mode === "sound" || mode === "notifications-and-sound"),
  };
}

export const kinDesktopNoticeDestination = ({ data }: KinDesktopNotice) =>
  kinNotificationDestination({ chatId: data.chatId, subject: data.subject });

/**
 * What a device that is open but not looked at alerts for: a chat whose unread count rose since
 * the last look. The first look alerts for nothing, so opening Kin doesn't replay old messages.
 */
export const KIN_MESSAGE_ALERTS = {
  title: "Notifications",
  purpose: "Your phone's notifications are set on the phone.",
  label: "Message alerts",
  detail: "On this computer, when Kin isn't in front",
  needsSecure:
    "Alerts need the desktop app, or Kin open at a secure (https) address. Sound only still works.",
  unavailable: "This browser can't show alerts. Sound only still works.",
  blocked:
    "Alerts from Kin are blocked in this browser. Allow alerts in browser settings. Sound only still works.",
  blockedDesktop:
    "Alerts from Kin are blocked on this computer. Allow alerts in system settings. Sound only still works.",
  blockedStatus: "Blocked",
  needsPermissionTitle: "Alerts need permission",
  needsPermissionDetail: "No alert banners show until allowed here.",
  allow: "Allow alerts",
  /** The in-app notice's button, which opens what the message is about. */
  open: "Open",
};

export type KinUnreadSeen = ReadonlyMap<string, number>;

export const kinUnreadSeen = (rows: ReadonlyArray<KinChatListRow>): KinUnreadSeen =>
  new Map(rows.map((row) => [row.chat.chatId, row.view.unread]));

export type KinShownAlert = { readonly environmentId: string; readonly chatId: string };

/**
 * Of the alerts this computer showed, those of `environmentId`'s chats settled now: read on any
 * device, or no longer in the person's list there. Another host's alerts are never judged by
 * this host's list. Their alert is taken down, as the phone's is withdrawn.
 */
export const kinSettledAlertChats = <A extends KinShownAlert>(
  shown: Iterable<A>,
  environmentId: string,
  rows: ReadonlyArray<KinChatListRow>,
): ReadonlyArray<A> => {
  const unread = kinUnreadSeen(rows);
  return [...shown].filter(
    (alert) => alert.environmentId === environmentId && (unread.get(alert.chatId) ?? 0) === 0,
  );
};

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
