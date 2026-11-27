import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
} from "./useSettings";
import { kinDefaultClientSettings, kinDefaultUnifiedSettings } from "../kin/kinClientSettings";

function setKinDesktopWindow(enabled: boolean) {
  if (enabled) {
    vi.stubGlobal("window", Object.assign(new EventTarget(), { kinDesktopWindow: true as const }));
  } else {
    vi.unstubAllGlobals();
  }
  __resetClientSettingsPersistenceForTests();
}

beforeEach(() => {
  persistenceMocks.getClientSettings.mockReset().mockResolvedValue(null);
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  setKinDesktopWindow(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetClientSettingsPersistenceForTests();
  vi.restoreAllMocks();
});

describe("Kin default notificationMode in client settings", () => {
  it("defaults to notifications-and-sound in the Kin desktop window when never chosen, and keeps it across other edits", async () => {
    setKinDesktopWindow(true);

    expect(getClientSettings().notificationMode).toBe("notifications-and-sound");
    await ensureClientSettingsHydrated();
    expect(getClientSettings().notificationMode).toBe("notifications-and-sound");

    await persistClientSettingsPatch({ wordWrap: false });
    expect(getClientSettings().notificationMode).toBe("notifications-and-sound");
    expect(persistenceMocks.setClientSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notificationMode: "notifications-and-sound",
        wordWrap: false,
      }),
    );
  });

  it("keeps any previously chosen notificationMode in Kin, including off", async () => {
    setKinDesktopWindow(true);
    for (const chosen of ["off", "sound", "notifications", "notifications-and-sound"] as const) {
      __resetClientSettingsPersistenceForTests();
      persistenceMocks.getClientSettings.mockResolvedValueOnce({
        ...DEFAULT_CLIENT_SETTINGS,
        notificationMode: chosen,
      });

      await ensureClientSettingsHydrated();
      expect(getClientSettings().notificationMode).toBe(chosen);
    }
  });

  it("keeps T3 Code's off default outside Kin and turns alerts on with sound for Kin web", async () => {
    setKinDesktopWindow(false);

    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    await ensureClientSettingsHydrated();
    expect(getClientSettings().notificationMode).toBe("off");

    expect(
      kinDefaultClientSettings({ kinWebOnly: true, inKinDesktopWindow: false }).notificationMode,
    ).toBe("notifications-and-sound");
    expect(kinDefaultClientSettings({ kinWebOnly: false, inKinDesktopWindow: false })).toBe(
      DEFAULT_CLIENT_SETTINGS,
    );
    expect(
      kinDefaultUnifiedSettings({ kinWebOnly: true, inKinDesktopWindow: false }).notificationMode,
    ).toBe("notifications-and-sound");
    expect(kinDefaultUnifiedSettings({ kinWebOnly: false, inKinDesktopWindow: false })).toBe(
      DEFAULT_UNIFIED_SETTINGS,
    );
  });
});
