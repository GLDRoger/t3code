import {
  kinBadgeCount,
  kinChatSettled,
  type KinInboxState,
} from "@t3tools/client-runtime/kin/kinInboxModel";
import type { EnvironmentId, KinChatId } from "@t3tools/contracts";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "../state/kinClient";
import { kinHostAtom } from "../state/useKinHost";
import { kinSettledNotificationIds } from "./kinPushPayload";

const warn = (what: string) => (cause: unknown) => console.warn(what, cause);

/** Removes this host's delivered notifications for the chats `settled` says are done. */
export async function dismissKinNotifications(
  environmentId: EnvironmentId,
  settled: (chatId: KinChatId) => boolean,
): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    kinSettledNotificationIds(presented, environmentId, settled).map((identifier) =>
      Notifications.dismissNotificationAsync(identifier),
    ),
  );
}

/**
 * While the app is in front, the live inbox is the truth: the icon shows its count and the
 * notification pane drops chats with nothing left to read. Pushes keep the icon right otherwise.
 */
export function installKinNotificationSync(): () => void {
  let environmentId: EnvironmentId | null = null;
  let unsubscribeInbox: (() => void) | null = null;
  let inbox: KinInboxState | null = null;
  let badge: number | null = null;

  const reconcile = () => {
    if (environmentId === null || inbox === null) return;
    const live = inbox;
    const count = kinBadgeCount(live);
    if (Platform.OS === "ios" && count !== badge) {
      badge = count;
      void Notifications.setBadgeCountAsync(count).catch(warn("Setting the Kin badge failed"));
    }
    void dismissKinNotifications(environmentId, (chatId) => kinChatSettled(live, chatId)).catch(
      warn("Clearing read Kin notifications failed"),
    );
  };

  const sync = () => {
    const host = appAtomRegistry.get(kinHostAtom);
    const next =
      host._tag === "host" && AppState.currentState === "active" ? host.environmentId : null;
    if (next === environmentId) return reconcile();
    unsubscribeInbox?.();
    unsubscribeInbox = null;
    environmentId = next;
    inbox = null;
    // Coming back, the phone may have changed the badge itself (a push), so set it again.
    badge = null;
    if (next === null) return;
    unsubscribeInbox = appAtomRegistry.subscribe(
      kinClient.inbox({ environmentId: next, input: {} }),
      (result) => {
        // Only a live inbox: a saved one would put an old count back on the icon.
        if (result._tag !== "Success" || !result.value.live) return;
        inbox = result.value.value;
        reconcile();
      },
      { immediate: true },
    );
  };

  const unsubscribeHost = appAtomRegistry.subscribe(kinHostAtom, sync, { immediate: true });
  const appState = AppState.addEventListener("change", sync);
  return () => {
    unsubscribeHost();
    appState.remove();
    unsubscribeInbox?.();
  };
}
