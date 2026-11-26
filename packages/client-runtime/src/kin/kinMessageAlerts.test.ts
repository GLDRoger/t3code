import type { ClientSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import type { KinChatListRow } from "./kinChatListRows.ts";
import {
  KIN_MESSAGE_ALERTS,
  kinAlertSettingsNotice,
  kinArrivalNotices,
  kinDefaultNotificationMode,
  kinDesktopNoticeShows,
  kinNewArrivals,
  kinSettledAlertChats,
  kinUnreadSeen,
} from "./kinMessageAlerts.ts";

const row = (chatId: string, unread: number, muted = false) =>
  ({
    chat: { chatId },
    view: { title: chatId, unread, muted },
    author: null,
    preview: "Invented line",
  }) as unknown as KinChatListRow;

describe("kinNewArrivals", () => {
  it("alerts for a rise in unread, never on the first look or for a muted chat", () => {
    const before = [row("a", 1), row("b", 0), row("c", 0, true)];
    expect(kinNewArrivals(null, before)).toEqual([]);
    const after = [row("a", 1), row("b", 2), row("c", 3, true), row("d", 1)];
    expect(kinNewArrivals(kinUnreadSeen(before), after).map((one) => one.chat.chatId)).toEqual([
      "b",
      "d",
    ]);
  });
});

describe("kinArrivalNotices", () => {
  it("tells the system in another window, else the app, never for the chat on screen", () => {
    const arrivals = [row("a", 1), row("b", 2)];
    const ids = (rows: ReadonlyArray<KinChatListRow>) => rows.map((one) => one.chat.chatId);
    const away = kinArrivalNotices(arrivals, { looking: false, onScreenChatId: "a" });
    expect([ids(away.system), ids(away.inApp)]).toEqual([["a", "b"], []]);
    // Looking at chat "a" in Kin: "b" arrives as an in-app notice, "a" is already in view.
    const here = kinArrivalNotices(arrivals, { looking: true, onScreenChatId: "a" });
    expect([ids(here.system), ids(here.inApp)]).toEqual([[], ["b"]]);
    const elsewhere = kinArrivalNotices(arrivals, { looking: true, onScreenChatId: null });
    expect(ids(elsewhere.inApp)).toEqual(["a", "b"]);
    const desktopCases = {
      off: [null, null],
      notifications: [
        { banner: true, sound: false },
        { banner: true, sound: false },
      ],
      sound: [
        { banner: false, sound: false },
        { banner: false, sound: true },
      ],
      "notifications-and-sound": [
        { banner: true, sound: false },
        { banner: true, sound: true },
      ],
    } as const satisfies Record<ClientSettings["notificationMode"], readonly [unknown, unknown]>;
    for (const mode in desktopCases) {
      const setting = mode as keyof typeof desktopCases;
      for (const ring of [false, true]) {
        expect(kinDesktopNoticeShows({ ring }, { looking: true, mode: setting })).toBeNull();
        expect(kinDesktopNoticeShows({ ring }, { looking: false, mode: setting })).toEqual(
          desktopCases[setting][ring ? 1 : 0],
        );
      }
    }
  });
});

describe("kinSettledAlertChats", () => {
  it("takes down a shown alert once its chat is read anywhere, or gone from the list", () => {
    const rows = [row("read", 0), row("unread", 2), row("muted-read", 0, true)];
    const here = (chatId: string) => ({ environmentId: "env-1", chatId });
    expect(
      kinSettledAlertChats([here("read"), here("unread"), here("left")], "env-1", rows),
    ).toEqual([here("read"), here("left")]);
  });

  it("never takes down another host's alert because this host's list lacks its chat", () => {
    const rows = [row("read", 0)];
    const there = { environmentId: "env-2", chatId: "read" };
    const other = { environmentId: "env-2", chatId: "elsewhere" };
    expect(kinSettledAlertChats([there, other], "env-1", rows)).toEqual([]);
  });
});

describe("kinDefaultNotificationMode", () => {
  it("defaults to on with sound in Kin desktop and Kin web, and stays off in T3 Code", () => {
    expect(kinDefaultNotificationMode({ kinWebOnly: false, inKinDesktopWindow: true })).toBe(
      "notifications-and-sound",
    );
    expect(kinDefaultNotificationMode({ kinWebOnly: true, inKinDesktopWindow: false })).toBe(
      "notifications-and-sound",
    );
    expect(kinDefaultNotificationMode({ kinWebOnly: true, inKinDesktopWindow: true })).toBe(
      "notifications-and-sound",
    );
    expect(kinDefaultNotificationMode({ kinWebOnly: false, inKinDesktopWindow: false })).toBe(
      "off",
    );
  });
});

describe("kinAlertSettingsNotice", () => {
  it("reports blocked and ungranted alert permission only when banner alerts are on", () => {
    expect(kinAlertSettingsNotice({ mode: "off", permission: "denied", desktop: false })).toEqual({
      status: null,
      problem: null,
      canAsk: false,
    });
    expect(
      kinAlertSettingsNotice({ mode: "sound", permission: "default", desktop: false }),
    ).toEqual({ status: null, problem: null, canAsk: false });
    expect(
      kinAlertSettingsNotice({
        mode: "notifications-and-sound",
        permission: "granted",
        desktop: true,
      }),
    ).toEqual({ status: null, problem: null, canAsk: false });
    expect(
      kinAlertSettingsNotice({
        mode: "notifications-and-sound",
        permission: "default",
        desktop: false,
      }),
    ).toEqual({ status: null, problem: null, canAsk: true });
    expect(
      kinAlertSettingsNotice({
        mode: "notifications-and-sound",
        permission: "denied",
        desktop: false,
      }),
    ).toEqual({
      status: KIN_MESSAGE_ALERTS.blockedStatus,
      problem: KIN_MESSAGE_ALERTS.blocked,
      canAsk: false,
    });
    expect(
      kinAlertSettingsNotice({
        mode: "notifications",
        permission: "denied",
        desktop: true,
      }),
    ).toEqual({
      status: KIN_MESSAGE_ALERTS.blockedStatus,
      problem: KIN_MESSAGE_ALERTS.blockedDesktop,
      canAsk: false,
    });
    expect(
      kinAlertSettingsNotice({
        mode: "notifications-and-sound",
        permission: "insecure",
        desktop: false,
      }),
    ).toEqual({ status: null, problem: KIN_MESSAGE_ALERTS.needsSecure, canAsk: false });
  });
});
