import { describe, expect, it } from "vite-plus/test";

import { kinStackWithoutChat } from "./kinChatStack";

const chat = (name: string, chatId: string) => ({
  name,
  key: `${name}-${chatId}`,
  params: { chatId },
});
const names = (state: { readonly routes: ReadonlyArray<{ readonly name: string }> }) =>
  state.routes.map((route) => route.name);

describe("kinStackWithoutChat", () => {
  it("adds the list when a notification opened the chat without it", () => {
    const state = { routes: [{ name: "Home" }, chat("KinChat", "g1"), chat("KinGroup", "g1")] };
    const next = kinStackWithoutChat(state, "g1", "KinChats");
    expect(names(next)).toEqual(["Home", "KinChats"]);
    expect(next.index).toBe(1);
  });

  it("goes back to the list that was there, keeping other chats below it", () => {
    const state = {
      routes: [
        { name: "Home" },
        chat("KinChat", "other"),
        { name: "KinChats", key: "list" },
        chat("KinChat", "g1"),
        chat("KinGroup", "g1"),
      ],
    };
    const next = kinStackWithoutChat(state, "g1", "KinChats");
    expect(next.routes.map((route) => route.key ?? route.name)).toEqual([
      "Home",
      "KinChat-other",
      "list",
    ]);
  });

  it("ends on Home where Kin is the whole app", () => {
    const state = { routes: [{ name: "Home" }, chat("KinChat", "g1"), chat("KinGroup", "g1")] };
    expect(names(kinStackWithoutChat(state, "g1", "Home"))).toEqual(["Home"]);
  });
});
