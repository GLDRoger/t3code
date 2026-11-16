import { kinChatListRows } from "@t3tools/client-runtime/kin/kinChatListRows";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  KIN_MESSAGE_ALERTS,
  kinArrivalText,
  kinNewArrivals,
  kinUnreadSeen,
  type KinUnreadSeen,
} from "@t3tools/client-runtime/kin/kinMessageAlerts";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { NotificationSettings } from "../components/settings/NotificationSettings";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { useClientSettings } from "../hooks/useSettings";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import { useKinInbox } from "./useKinHost";

/** Settings → You → Notifications: this computer's alerts for Kin messages. */
export function KinSettingsNotifications() {
  return (
    // This device's own setting: the app-wide scope, which the Kin modal doesn't otherwise hold.
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <SettingsPageContainer>
        <SettingsSection title={KIN_MESSAGE_ALERTS.title}>
          <NotificationSettings
            description={KIN_MESSAGE_ALERTS.detail}
            label={KIN_MESSAGE_ALERTS.label}
          />
        </SettingsSection>
      </SettingsPageContainer>
    </SettingsScopeProvider>
  );
}

const looking = () => document.visibilityState === "visible" && document.hasFocus();

/** Rings this computer when a chat gets a message while Kin is open in a window you aren't in. */
export function KinMessageAlerts() {
  const { host, state } = useKinInbox();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const navigate = useNavigate();
  const seen = useRef<KinUnreadSeen | null>(null);
  const environmentId = state._tag === "ready" ? state.environmentId : null;
  const rows =
    state._tag === "ready"
      ? kinChatListRows(selectKinInboxView(state.inbox.value), kinDirectory(host))
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- raises the system's notification and sound, outside React, for a message that just arrived
  useEffect(() => {
    if (rows === null || environmentId === null) return;
    const arrivals = kinNewArrivals(seen.current, rows);
    seen.current = kinUnreadSeen(rows);
    if (arrivals.length === 0 || mode === "off" || looking()) return;
    if (hasNotificationSound(mode)) void playNotificationSound("input", () => !looking());
    if (!hasDesktopNotifications(mode) || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    for (const row of arrivals) {
      const { title, body } = kinArrivalText(row);
      const alert = new Notification(title, { body, tag: `kin:${row.chat.chatId}` });
      alert.onclick = () => {
        window.focus();
        void navigate({
          to: "/kin/$environmentId/$orgId/$chatId",
          params: {
            environmentId,
            orgId: row.chat.orgId,
            chatId: row.chat.chatId,
          },
        });
        alert.close();
      };
    }
    // Runs again on every inbox change; `seen` makes a repeat look at the same counts a no-op.
  }, [rows, mode, environmentId, navigate]);
  return null;
}
