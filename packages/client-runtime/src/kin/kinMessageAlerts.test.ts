import { describe, expect, it } from "vite-plus/test";

import type { KinChatListRow } from "./kinChatListRows.ts";
import { kinNewArrivals, kinUnreadSeen } from "./kinMessageAlerts.ts";

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
