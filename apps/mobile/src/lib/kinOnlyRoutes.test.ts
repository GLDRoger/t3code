import { describe, expect, it } from "vite-plus/test";

import {
  kinOnlyLinkState,
  kinOnlyRouteNames,
  kinOnlyScreens,
  kinThreadWebUrl,
} from "./kinOnlyRoutes";

const allowed = kinOnlyRouteNames(["KinChats", "KinChat", "KinWork"]);
const home = { routes: [{ name: "Home" }] };

describe("kinOnlyScreens", () => {
  const screens = { Home: 1, Thread: 2, PullRequest: 3, KinChat: 4, KinChats: 5, SettingsUsage: 6 };

  it("registers every screen in a build that also has the coding app", () => {
    expect(kinOnlyScreens(screens, null)).toBe(screens);
  });

  it("registers no coding screen, and no second chat list, in a Kin-only build", () => {
    expect(Object.keys(kinOnlyScreens(screens, allowed))).toEqual(["Home", "KinChat"]);
  });
});

describe("kinOnlyLinkState", () => {
  it.each([
    { label: "a thread", routes: [{ name: "Home" }, { name: "Thread" }] },
    { label: "a pull request", routes: [{ name: "PullRequest" }] },
    { label: "usage", routes: [{ name: "Settings" }, { name: "SettingsUsage" }] },
    { label: "the pushed chat list", routes: [{ name: "KinChats" }] },
    { label: "a path no screen has", routes: [{ name: "NotFound" }] },
    { label: "an empty state", routes: [] },
  ])("opens the chat list for a link to $label", ({ routes }) => {
    expect(kinOnlyLinkState({ routes }, allowed)).toEqual(home);
  });

  it("opens the chat list for a link nothing could parse", () => {
    expect(kinOnlyLinkState(undefined, allowed)).toEqual(home);
  });

  it.each([
    {
      label: "a Kin chat",
      routes: [{ name: "Home" }, { name: "KinChat", params: { chatId: "c" } }],
    },
    { label: "a setting this app has", routes: [{ name: "Settings" }, { name: "SettingsAbout" }] },
    { label: "pairing", routes: [{ name: "ConnectionsNew", params: { pairingUrl: "x" } }] },
  ])("keeps a link to $label", ({ routes }) => {
    const state = { routes };
    expect(kinOnlyLinkState(state, allowed)).toBe(state);
  });
});

describe("kinThreadWebUrl", () => {
  const thread = { environmentId: "env 1", threadId: "thread/2" };

  it("is the thread's page on the paired computer's web app", () => {
    expect(kinThreadWebUrl("https://kin.example.test:3773/", thread)).toBe(
      "https://kin.example.test:3773/threads/env%201/thread%2F2",
    );
  });

  it.each([
    { label: "a relay connection with no address", address: null },
    { label: "an SSH target", address: "owner@kin.example.test" },
    { label: "a scheme a browser can't open", address: "ssh://kin.example.test" },
  ])("is nothing for $label", ({ address }) => {
    expect(kinThreadWebUrl(address, thread)).toBeNull();
  });
});
