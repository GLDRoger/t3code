import { kinChatListRows } from "@t3tools/client-runtime/kin/kinChatListRows";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  KIN_MESSAGE_ALERTS,
  kinArrivalNotices,
  kinArrivalText,
  kinNewArrivals,
  kinUnreadSeen,
  type KinUnreadSeen,
} from "@t3tools/client-runtime/kin/kinMessageAlerts";
import {
  kinChatArrivalDestination,
  type KinNotificationDestination,
} from "@t3tools/client-runtime/kin/kinNotificationDestination";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { NotificationSettings } from "../components/settings/NotificationSettings";
import { SettingsSection } from "../components/settings/settingsLayout";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { toastManager } from "../components/ui/toast";
import { useClientSettings } from "../hooks/useSettings";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import { KIN_PLACE_PATH, kinRecordPlace } from "./kinPlaces";
import { useKinInbox } from "./useKinHost";

/** Settings → You → Notifications: this computer's alerts for Kin messages. */
export function KinSettingsNotifications() {
  return (
    // This device's own setting: the app-wide scope, which the Kin modal doesn't otherwise hold.
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-2 p-4 sm:p-6">
        <SettingsSection title={KIN_MESSAGE_ALERTS.title} hideTitle>
          <NotificationSettings
            title={KIN_MESSAGE_ALERTS.label}
            description={KIN_MESSAGE_ALERTS.detail}
            label={KIN_MESSAGE_ALERTS.label}
          />
        </SettingsSection>
      </div>
    </SettingsScopeProvider>
  );
}

const looking = () => document.visibilityState === "visible" && document.hasFocus();

/** Where a notice opens, as the phone's tap on the same push does: the entry, the card, the chat. */
export function openDestination(
  navigate: ReturnType<typeof useNavigate>,
  where: { readonly environmentId: EnvironmentId; readonly orgId: string },
  destination: KinNotificationDestination,
) {
  if (destination._tag === "chat")
    return navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { ...where, chatId: destination.chatId },
      search: destination.messageId === null ? {} : { message: destination.messageId },
    });
  if (destination._tag === "tasks") return navigate({ to: KIN_PLACE_PATH.tasks, params: where });
  const { key, kind } = destination;
  return navigate({ ...kinRecordPlace({ _tag: "record", key, kind }), params: where });
}

/**
 * Rings this computer when a chat gets a message while Kin is open in a window you aren't in, and
 * shows a notice in Kin when you are on another page or chat.
 */
export function KinMessageAlerts() {
  const { host, state } = useKinInbox();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const navigate = useNavigate();
  const onScreenChatId = useParams({ strict: false }).chatId ?? null;
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
    if (arrivals.length === 0 || mode === "off") return;
    const { system, inApp } = kinArrivalNotices(arrivals, { looking: looking(), onScreenChatId });
    const open = (row: (typeof arrivals)[number]) =>
      void openDestination(
        navigate,
        { environmentId, orgId: row.chat.orgId },
        kinChatArrivalDestination(row.chat),
      );
    for (const row of inApp) {
      const { title, body } = kinArrivalText(row);
      const notice = toastManager.add({
        type: "info",
        title,
        description: body,
        actionProps: {
          children: KIN_MESSAGE_ALERTS.open,
          onClick: () => {
            toastManager.close(notice);
            open(row);
          },
        },
      });
    }
    if (system.length === 0) return;
    if (hasNotificationSound(mode)) void playNotificationSound("input", () => !looking());
    if (!hasDesktopNotifications(mode) || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    for (const row of system) {
      const { title, body } = kinArrivalText(row);
      const alert = new Notification(title, { body, tag: `kin:${row.chat.chatId}` });
      alert.onclick = () => {
        window.focus();
        open(row);
        alert.close();
      };
    }
    // Runs again on every inbox change; `seen` makes a repeat look at the same counts a no-op.
  }, [rows, mode, environmentId, navigate, onScreenChatId]);
  return null;
}
