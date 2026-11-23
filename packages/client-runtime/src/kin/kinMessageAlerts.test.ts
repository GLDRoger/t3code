import { describe, expect, it } from "vite-plus/test";

import type { KinChatListRow } from "./kinChatListRows.ts";
import { kinArrivalNotices, kinNewArrivals, kinUnreadSeen } from "./kinMessageAlerts.ts";

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
  });
});
