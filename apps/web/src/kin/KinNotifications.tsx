import { kinChatListRows } from "@t3tools/client-runtime/kin/kinChatListRows";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  KIN_MESSAGE_ALERTS,
  kinAlertSettingsNotice,
  kinArrivalNotices,
  kinArrivalText,
  kinNewArrivals,
  kinUnreadSeen,
  type KinAlertPermission,
  type KinUnreadSeen,
} from "@t3tools/client-runtime/kin/kinMessageAlerts";
import {
  kinChatArrivalDestination,
  type KinNotificationDestination,
} from "@t3tools/client-runtime/kin/kinNotificationDestination";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useMessages } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { useClientSettings } from "../hooks/useSettings";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  playNotificationSound,
  unlockNotificationAudio,
} from "../threadNotifications";
import { hasDesktopWindowChrome } from "./kinDesktopWindow";
import { KIN_PLACE_PATH, kinRecordPlace } from "./kinPlaces";
import { KinSettingsChoice } from "./settings/KinSettingsControls";
import {
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { KinQuietHoursSetting } from "./settings/KinQuietHoursSetting";
import type { KinSettingsTarget } from "./settings/kinSettingsTarget";
import { closeSettledKinAlerts, keepKinAlert, kinAlertTag } from "./kinSystemAlerts";
import { useKinInbox } from "./useKinHost";

const NOTIFICATION_PERMISSION_ASKED_KEY = "t3code:kin:notification-permission-asked:v1";
const permissionListeners = new Set<() => void>();
let askedNotificationPermissionInSession = false;

function readNotificationPermission(): KinAlertPermission {
  if (
    typeof window === "undefined" ||
    typeof Notification === "undefined" ||
    !window.isSecureContext
  )
    return "insecure";
  return Notification.permission;
}

function notifyPermissionChange() {
  for (const listener of permissionListeners) listener();
}

function hasAskedNotificationPermission(): boolean {
  if (askedNotificationPermissionInSession) return true;
  try {
    return window.localStorage.getItem(NOTIFICATION_PERMISSION_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function markNotificationPermissionAsked(): void {
  askedNotificationPermissionInSession = true;
  try {
    window.localStorage.setItem(NOTIFICATION_PERMISSION_ASKED_KEY, "1");
  } catch {
    // Storage can be blocked; the session flag still prevents repeated prompts.
  }
}

async function requestKinNotificationPermission() {
  markNotificationPermissionAsked();
  const result = await settlePromise(() => Notification.requestPermission());
  notifyPermissionChange();
  return result;
}

function useNotificationPermission(): KinAlertPermission {
  const [permission, setPermission] = useState<KinAlertPermission>(readNotificationPermission);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to browser permission changes and focus so Settings stays truthful
  useEffect(() => {
    const refresh = () => setPermission(readNotificationPermission());
    permissionListeners.add(refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    let status: PermissionStatus | null = null;
    if (typeof navigator !== "undefined" && navigator.permissions !== undefined) {
      void settlePromise(() => navigator.permissions.query({ name: "notifications" })).then(
        (result) => {
          if (result._tag !== "Success") return;
          status = result.value;
          status.addEventListener("change", refresh);
        },
      );
    }
    return () => {
      permissionListeners.delete(refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      status?.removeEventListener("change", refresh);
    };
  }, []);
  return permission;
}

/** Settings → You → Notifications: this computer's alerts for Kin messages, and your quiet hours. */
export function KinSettingsNotifications(props: KinSettingsTarget) {
  return (
    // This device's own setting: the app-wide scope, which the Kin modal doesn't otherwise hold.
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <KinSettingsPage purpose={KIN_MESSAGE_ALERTS.purpose}>
        <MessageAlerts />
        <KinQuietHoursSetting {...props} />
      </KinSettingsPage>
    </SettingsScopeProvider>
  );
}

const NOTIFICATION_MODES = ["off", "notifications", "sound", "notifications-and-sound"] as const;

/** Alerts and sound need the browser's leave first; until it gives it, the choice stays put. */
function MessageAlerts() {
  const searchableSetting = useSearchableSetting();
  const m = useMessages();
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const permission = useNotificationPermission();
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const notice = kinAlertSettingsNotice({ mode, permission, desktop: hasDesktopWindowChrome });
  const blockedCopy = hasDesktopWindowChrome
    ? KIN_MESSAGE_ALERTS.blockedDesktop
    : KIN_MESSAGE_ALERTS.blocked;
  const askPermission = async () => {
    if (typeof Notification === "undefined" || !window.isSecureContext) {
      setProblem(KIN_MESSAGE_ALERTS.needsSecure);
      return false;
    }
    setAsking(true);
    const result = await requestKinNotificationPermission();
    setAsking(false);
    if (result._tag === "Failure") {
      setProblem(KIN_MESSAGE_ALERTS.unavailable);
      return false;
    }
    if (result.value !== "granted") {
      setProblem(blockedCopy);
      return false;
    }
    return true;
  };
  const choose = async (next: (typeof NOTIFICATION_MODES)[number]) => {
    setProblem(null);
    if (hasNotificationSound(next)) unlockNotificationAudio();
    if (hasDesktopNotifications(next) && !(await askPermission())) return;
    updateSettings({ notificationMode: next });
  };
  const allowAlerts = async () => {
    setProblem(null);
    if (hasNotificationSound(mode)) unlockNotificationAudio();
    await askPermission();
  };
  return (
    <KinSettingsSection
      searchId={searchableSetting("thread-notifications").id}
      problem={problem ?? notice.problem}
    >
      <KinSettingsRow
        title={KIN_MESSAGE_ALERTS.label}
        detail={KIN_MESSAGE_ALERTS.detail}
        wrap
        stack
        status={
          notice.status === null ? null : (
            <KinSettingsStatus tone="attention">{notice.status}</KinSettingsStatus>
          )
        }
        control={
          <KinSettingsChoice
            label={KIN_MESSAGE_ALERTS.label}
            value={mode}
            disabled={asking}
            options={NOTIFICATION_MODES.map((value) => ({
              value,
              label: m(NOTIFICATION_MODE_LABELS[value]),
            }))}
            onChange={(next) => void choose(next)}
          />
        }
      />
      {notice.canAsk ? (
        <KinSettingsRow
          title={KIN_MESSAGE_ALERTS.needsPermissionTitle}
          detail={KIN_MESSAGE_ALERTS.needsPermissionDetail}
          wrap
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={asking}
              onClick={() => void allowAlerts()}
            >
              {KIN_MESSAGE_ALERTS.allow}
            </Button>
          }
        />
      ) : null}
    </KinSettingsSection>
  );
}

export const lookingAtKin = () => document.visibilityState === "visible" && document.hasFocus();

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
  return navigate({ ...kinRecordPlace({ key, kind }), params: where });
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- unlocks Web Audio while sound alerts are on (Electron needs no gesture; browsers unlock on first interaction)
  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    if (hasDesktopWindowChrome) unlockNotificationAudio();
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the browser for notification permission once on the first interaction after signing into Kin
  useEffect(() => {
    if (environmentId === null || !hasDesktopNotifications(mode)) return;
    if (
      typeof Notification === "undefined" ||
      !window.isSecureContext ||
      Notification.permission !== "default" ||
      hasAskedNotificationPermission()
    ) {
      return;
    }
    const askOnce = () => {
      document.removeEventListener("pointerdown", askOnce);
      document.removeEventListener("keydown", askOnce);
      if (Notification.permission !== "default" || hasAskedNotificationPermission()) return;
      void requestKinNotificationPermission();
    };
    document.addEventListener("pointerdown", askOnce);
    document.addEventListener("keydown", askOnce);
    return () => {
      document.removeEventListener("pointerdown", askOnce);
      document.removeEventListener("keydown", askOnce);
    };
  }, [environmentId, mode]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- raises the system's notification and sound, outside React, for a message that just arrived
  useEffect(() => {
    if (rows === null || environmentId === null) return;
    closeSettledKinAlerts(environmentId, rows);
    const arrivals = kinNewArrivals(seen.current, rows);
    seen.current = kinUnreadSeen(rows);
    if (arrivals.length === 0 || mode === "off") return;
    const { system, inApp } = kinArrivalNotices(arrivals, {
      looking: lookingAtKin(),
      onScreenChatId,
    });
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
        // Four lines, as a phone's banner shows the same message.
        description: <span className="line-clamp-4">{body}</span>,
        actionProps: {
          children: KIN_MESSAGE_ALERTS.open,
          onClick: () => {
            toastManager.close(notice);
            open(row);
          },
        },
      });
    }
    if (hasDesktopWindowChrome || system.length === 0) return;
    if (hasNotificationSound(mode)) void playNotificationSound("input", () => !lookingAtKin());
    if (!hasDesktopNotifications(mode) || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    for (const row of system) {
      const { title, body } = kinArrivalText(row);
      const alert = new Notification(title, {
        body,
        silent: true,
        tag: kinAlertTag(environmentId, row.chat.chatId),
      });
      keepKinAlert(environmentId, row.chat.chatId, alert);
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
