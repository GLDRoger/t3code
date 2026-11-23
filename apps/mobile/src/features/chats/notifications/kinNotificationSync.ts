import {
  kinBadgeCount,
  kinChatSettled,
  type KinInboxState,
} from "@t3tools/client-runtime/kin/kinInboxModel";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  KIN_PUSH_TOPICS_MAX,
  type EnvironmentId,
  type KinChatId,
  type KinOrgId,
  type KinPushTopic,
} from "@t3tools/contracts";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "../state/kinClient";
import { kinHostAtom } from "../state/useKinHost";
import { kinDeliveredTopics, kinSettledNotificationIds, kinWithdrawnIds } from "./kinPushPayload";

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
 * Asks the host once which of its delivered notifications are settled and removes those, healing
 * a withdrawal the OS never woke the app for. Nothing delivered from it, nothing to ask.
 */
async function reconcileWithHost(environmentId: EnvironmentId): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  const byOrg = new Map<KinOrgId, Set<KinPushTopic>>();
  for (const { orgId, topic } of kinDeliveredTopics(presented, environmentId))
    byOrg.set(orgId, (byOrg.get(orgId) ?? new Set()).add(topic));
  for (const [orgId, topics] of byOrg) {
    const result = await runAtomCommand(
      appAtomRegistry,
      kinClient.reconcilePush,
      { environmentId, input: { orgId, topics: [...topics].slice(0, KIN_PUSH_TOPICS_MAX) } },
      { reportFailure: false },
    );
    if (result._tag !== "Success") continue;
    await Promise.all(
      kinWithdrawnIds(presented, { environmentId, orgId }, result.value.remove).map((identifier) =>
        Notifications.dismissNotificationAsync(identifier),
      ),
    );
    if (Platform.OS === "ios") await Notifications.setBadgeCountAsync(result.value.badge);
  }
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
  // Once per coming to the front, when the host first answers; again whenever a push arrives.
  let reconciled = false;
  let reconciling = false;
  const reconcileOnce = () => {
    if (environmentId === null || reconciling) return;
    reconciling = true;
    void reconcileWithHost(environmentId)
      .catch(warn("Reconciling Kin notifications failed"))
      .finally(() => {
        reconciling = false;
      });
  };

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
    reconciled = false;
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
        if (!reconciled) {
          reconciled = true;
          reconcileOnce();
        }
      },
      { immediate: true },
    );
  };

  const unsubscribeHost = appAtomRegistry.subscribe(kinHostAtom, sync, { immediate: true });
  const appState = AppState.addEventListener("change", sync);
  const arrived = Notifications.addNotificationReceivedListener(reconcileOnce);
  return () => {
    unsubscribeHost();
    appState.remove();
    arrived.remove();
    unsubscribeInbox?.();
  };
}
