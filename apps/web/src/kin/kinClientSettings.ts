import { kinDefaultNotificationMode } from "@t3tools/client-runtime/kin/kinMessageAlerts";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type ClientSettings,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";

import { isInKinDesktopWindow } from "./kinDesktopWindow";
import { KIN_WEB_ONLY } from "./kinWebOnly";

const KIN_DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  notificationMode: "notifications-and-sound",
};

const KIN_DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  ...KIN_DEFAULT_CLIENT_SETTINGS,
};

/**
 * Starting client settings before anything is saved on this device. Non-Kin builds keep T3 Code's
 * own object; Kin desktop and Kin web start with message alerts and sound on.
 */
export function kinDefaultClientSettings(
  context: { readonly kinWebOnly: boolean; readonly inKinDesktopWindow: boolean } = {
    kinWebOnly: KIN_WEB_ONLY,
    inKinDesktopWindow: isInKinDesktopWindow(),
  },
): ClientSettings {
  const mode = kinDefaultNotificationMode(context);
  return mode === DEFAULT_CLIENT_SETTINGS.notificationMode
    ? DEFAULT_CLIENT_SETTINGS
    : KIN_DEFAULT_CLIENT_SETTINGS;
}

/**
 * Starting unified settings for this window: T3's defaults outside Kin, and Kin's starting client
 * settings merged over T3's server defaults inside Kin. Both initial load and "Restore default
 * settings" read from here so they cannot drift.
 */
export function kinDefaultUnifiedSettings(
  context?: Parameters<typeof kinDefaultClientSettings>[0],
): UnifiedSettings {
  const client = kinDefaultClientSettings(context);
  if (client === DEFAULT_CLIENT_SETTINGS) return DEFAULT_UNIFIED_SETTINGS;
  return client === KIN_DEFAULT_CLIENT_SETTINGS
    ? KIN_DEFAULT_UNIFIED_SETTINGS
    : { ...DEFAULT_UNIFIED_SETTINGS, ...client };
}
