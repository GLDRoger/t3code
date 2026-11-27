import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type ClientSettings,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const restoreMocks = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  updateSettings: vi.fn<(patch: Partial<UnifiedSettings>) => void>(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock(import("gt-react"), async (importOriginal) => {
  const actual = await importOriginal();
  const identity = (text: string, vars?: Record<string, unknown>) =>
    vars === undefined
      ? text
      : text.replace(/\{(\w+)\}/g, (_match, key: string) => String(vars[key] ?? ""));
  return {
    ...actual,
    useGT: () => identity as unknown as ReturnType<typeof actual.useGT>,
    useMessages: () => identity as unknown as ReturnType<typeof actual.useMessages>,
  };
});

vi.mock("../components/settings/useScopedSettings", () => ({
  useScopedSettings: () => restoreMocks.settings,
  useUpdateScopedSettings: () => restoreMocks.updateSettings,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "system" as const,
    setTheme: vi.fn(() => true),
    followSystem: true,
    setFollowSystem: vi.fn(() => true),
    setThemeHalf: vi.fn(() => true),
    clearThemeHalves: vi.fn(() => true),
    themeHalves: null,
  }),
  readThemePreference: () => "system" as const,
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system" as const,
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: restoreMocks.confirm } }),
  ensureLocalApi: () => ({ dialogs: { confirm: restoreMocks.confirm } }),
}));

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { kinDefaultClientSettings } from "./kinClientSettings";

const kinOverrides = (Object.keys(DEFAULT_CLIENT_SETTINGS) as Array<keyof ClientSettings>).flatMap(
  (key) => {
    const kinValue = kinDefaultClientSettings({
      kinWebOnly: true,
      inKinDesktopWindow: false,
    })[key];
    const t3Value = DEFAULT_CLIENT_SETTINGS[key];
    return kinValue === t3Value ? [] : [{ key, kinValue, t3Value }];
  },
);

function Probe({
  onRead,
}: {
  readonly onRead: (value: ReturnType<typeof useSettingsRestore>) => void;
}) {
  onRead(useSettingsRestore());
  return null;
}

function readRestore() {
  let result!: ReturnType<typeof useSettingsRestore>;
  renderToStaticMarkup(
    <Probe
      onRead={(value) => {
        result = value;
      }}
    />,
  );
  return result;
}

function setKinDesktopWindow(enabled: boolean) {
  if (enabled) {
    vi.stubGlobal("window", Object.assign(new EventTarget(), { kinDesktopWindow: true as const }));
  } else {
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  restoreMocks.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  restoreMocks.updateSettings.mockReset();
  restoreMocks.confirm.mockReset().mockResolvedValue(true);
  setKinDesktopWindow(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSettingsRestore in Kin", () => {
  it("lists at least one Kin starting override", () => {
    expect(kinOverrides.length).toBeGreaterThan(0);
  });

  it.each(kinOverrides)(
    "treats Kin's starting $key as clean and restores it to $kinValue",
    async ({ key, kinValue, t3Value }) => {
      setKinDesktopWindow(true);
      const kinDefaults: UnifiedSettings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        ...kinDefaultClientSettings({ kinWebOnly: false, inKinDesktopWindow: true }),
      };

      // At Kin's starting values, nothing is marked changed.
      restoreMocks.settings = kinDefaults;
      expect(readRestore().changedSettingLabels).toEqual([]);

      // After moving the setting to T3's default, Restore brings back Kin's starting value.
      restoreMocks.settings = { ...kinDefaults, [key]: t3Value };
      const dirty = readRestore();
      expect(dirty.changedSettingLabels.length).toBeGreaterThan(0);
      await dirty.restoreDefaults();
      expect(restoreMocks.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ [key]: kinValue }),
      );
    },
  );

  it.each(kinOverrides)(
    "keeps T3's default $t3Value for $key outside Kin",
    async ({ key, kinValue, t3Value }) => {
      setKinDesktopWindow(false);
      restoreMocks.settings = { ...DEFAULT_UNIFIED_SETTINGS };
      expect(readRestore().changedSettingLabels).toEqual([]);

      restoreMocks.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: kinValue };
      const dirty = readRestore();
      expect(dirty.changedSettingLabels.length).toBeGreaterThan(0);
      await dirty.restoreDefaults();
      expect(restoreMocks.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ [key]: t3Value }),
      );
    },
  );
});
