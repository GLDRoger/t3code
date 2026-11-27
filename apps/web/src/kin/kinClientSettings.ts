import { kinDefaultNotificationMode } from "@t3tools/client-runtime/kin/kinMessageAlerts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";

import { isInKinDesktopWindow } from "./kinDesktopWindow";
import { KIN_WEB_ONLY } from "./kinWebOnly";

const KIN_DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  notificationMode: "notifications-and-sound",
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
