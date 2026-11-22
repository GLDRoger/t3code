import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_GROUPS } from "../components/settings/settingsSearch";
import { kinCodingLanding, kinSettingsShown } from "./kinNoCode";
import { kinSettingsNavGroups } from "./useKinSettingsNavGroups";

const HELPER = "thread:delegated-task:command%3Amcp%3Aa1%3Adelegate-task%3Ab2";

describe("kinCodingLanding", () => {
  it.each([
    ["/kin", null],
    ["/kin/env-1/kin-default/chat-1", null],
    ["/settings/providers", null],
    ["/settings/general", null],
    ["/settings/worktrees", { stray: null, settings: true }],
    ["/settings/archived/", { stray: null, settings: true }],
    ["/usage", null],
    ["/pair", null],
    ["/kin/invite", null],
    ["/", { stray: null }],
    ["/new", { stray: null }],
    ["/draft/draft-1", { stray: null }],
    ["/projects/env-1%2Fproject-1", { stray: null }],
    ["/pull-requests", { stray: null }],
    ["/issues", { stray: null }],
    [
      `/env-1/${encodeURIComponent(HELPER)}`,
      { stray: { environmentId: "env-1", threadId: HELPER } },
    ],
    ["/threads/env-1/kin%3A01ABC", { stray: { environmentId: "env-1", threadId: "kin:01ABC" } }],
  ] as const)("%s", (pathname, landing) => {
    expect(kinCodingLanding(pathname)).toEqual(landing);
  });
});

describe("the Kin web app's settings", () => {
  const paths = (groups: typeof SETTINGS_NAV_GROUPS) => groups.flatMap((group) => group.paths);

  it("lists and finds no coding settings page, and keeps the rest", () => {
    const listed = paths(
      kinSettingsNavGroups(SETTINGS_NAV_GROUPS, { overKin: true, kinOnly: true }),
    );
    for (const hidden of ["/settings/worktrees", "/settings/diffs", "/settings/archived"]) {
      expect(listed).not.toContain(hidden);
    }
    expect(listed).toEqual(
      expect.arrayContaining(["/settings/providers", "/settings/appearance", "/settings/about"]),
    );
    expect(
      kinSettingsShown([{ to: "/settings/threads" }, { to: "/settings/keybindings" }], true),
    ).toEqual([{ to: "/settings/keybindings" }]);
  });

  it("leaves T3 Code's own build as it was", () => {
    expect(kinSettingsNavGroups(SETTINGS_NAV_GROUPS, { overKin: false, kinOnly: false })).toBe(
      SETTINGS_NAV_GROUPS,
    );
    const items = [{ to: "/settings/threads" }];
    expect(kinSettingsShown(items, false)).toBe(items);
  });
});
