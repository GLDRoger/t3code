import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_GROUPS, SETTINGS_SEARCH_ITEMS } from "../components/settings/settingsSearch";
import {
  KIN_CODING_SETTINGS,
  KIN_CODING_SETTING_ROWS,
  kinKeyShown,
  kinCodingLanding,
  kinSettingHidden,
  kinSettingsShown,
} from "./kinNoCode";
import { KIN_SETTINGS_SEARCH_ITEMS } from "./kinSettingsSearch";
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

  const KIN_SEARCH_IDS = new Set<string>(KIN_SETTINGS_SEARCH_ITEMS.map((item) => item.id));
  const rowsByPage = (items: ReadonlyArray<{ readonly id: string; readonly to: string }>) => {
    const pages: Record<string, Array<string>> = {};
    for (const item of items) {
      if (item.id.startsWith("keybinding-") || KIN_SEARCH_IDS.has(item.id)) continue;
      (pages[item.to] ??= []).push(item.id);
    }
    for (const rows of Object.values(pages)) rows.sort();
    return pages;
  };

  it("draws and finds only the rows of kept pages that serve Kin", () => {
    const shown = kinSettingsShown(SETTINGS_SEARCH_ITEMS, true);
    expect(shown.every((item) => !KIN_CODING_SETTINGS.has(item.to))).toBe(true);
    expect(rowsByPage(shown)).toMatchInlineSnapshot(`
      {
        "/settings/about": [
          "app-version",
          "open-source-licenses",
          "privacy-policy",
          "update-track",
          "welcome-page",
        ],
        "/settings/access": [
          "connect-device-approval",
          "connections-environment",
          "environment-icon",
          "hold-webhooks-while-offline",
          "network-access",
          "publish-agent-activity",
          "t3-connect",
          "tailscale-https",
          "wsl-backend",
        ],
        "/settings/appearance": [
          "code-font",
          "color-scheme",
          "environment-identification",
          "font-smoothing",
          "interface-font",
          "math-rendering",
          "panel-animations",
          "setting-appearance-contrast",
          "setting-glass-opacity",
          "theme",
          "word-wrap",
        ],
        "/settings/connections": [
          "linked-environments",
          "local-environment",
          "remote-environments",
        ],
        "/settings/diagnostics": [
          "telemetry-export",
        ],
        "/settings/general": [
          "language",
          "quit-confirmation",
          "time-format",
        ],
        "/settings/keybindings": [
          "keybindings",
        ],
        "/settings/labs": [
          "linked-environments-beta",
        ],
        "/settings/maintenance": [
          "background-activity",
          "continue-threads-after-server-update",
          "diagnostics",
          "keep-awake-while-agents-work",
          "provider-update-checks",
          "storage-artifacts",
          "storage-delete-now",
        ],
        "/settings/providers": [
          "compact-idle-threads",
          "provider-health-check-interval",
          "providers",
          "usage-providers",
        ],
        "/settings/secrets": [
          "secret-providers",
          "secret-providers-add",
        ],
      }
    `);
    expect(shown.filter((item) => item.id.startsWith("keybinding-")).map((item) => item.id))
      .toMatchInlineSnapshot(`
      [
        "keybinding-appearance.cycle",
        "keybinding-commandPalette.toggle",
        "keybinding-workspace.focusNext",
        "keybinding-workspace.focusPrevious",
        "keybinding-kin.switchList",
        "keybinding-navigation.back",
        "keybinding-navigation.forward",
        "keybinding-sidebar.toggle",
        "keybinding-themeEditor.toggle",
        "keybinding-theme.select",
        "keybinding-usage.cost",
        "keybinding-usage.limits",
        "keybinding-usage.open",
        "keybinding-usage.period.month",
        "keybinding-usage.period.week",
        "keybinding-usage.period.quarter",
        "keybinding-usage.period.day",
        "keybinding-usage.tokens",
      ]
    `);
    for (const id of KIN_CODING_SETTING_ROWS) expect(kinSettingHidden(id, true)).toBe(true);
    expect(kinKeyShown("composer.previousWorktree", true)).toBe(false);
    expect(kinKeyShown("commandPalette.toggle", true)).toBe(true);
  });

  it("draws every row of every page in T3 Code's own build", () => {
    expect(kinSettingsShown(SETTINGS_SEARCH_ITEMS, false)).toBe(SETTINGS_SEARCH_ITEMS);
    const anchors = [
      ...SETTINGS_SEARCH_ITEMS.map((item) => item.id),
      ...KIN_CODING_SETTING_ROWS,
      "confirmations",
    ];
    expect(anchors.filter((id) => kinSettingHidden(id, false))).toEqual([]);
    expect(kinKeyShown("composer.previousWorktree", false)).toBe(true);
  });
});
