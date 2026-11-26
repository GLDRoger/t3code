import {
  kinBadgeCount,
  kinChatSettled,
  kinInboxSettledSince,
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
import { kinCoalesced } from "./kinCoalesced";
import {
  kinDeliveredTopics,
  kinIncomingSettled,
  kinReconcileRemovals,
  kinSettledNotificationIds,
} from "./kinPushPayload";

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

const ASK_WITHIN_MS = 1_500;

/** The host's reconcile answer, or null when it fails or takes longer than `ASK_WITHIN_MS`. */
async function askHost(
  environmentId: EnvironmentId,
  input: { readonly orgId: KinOrgId; readonly topics: ReadonlyArray<KinPushTopic> },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ASK_WITHIN_MS);
  });
  const asked = runAtomCommand(
    appAtomRegistry,
    kinClient.reconcilePush,
    { environmentId, input: { orgId: input.orgId, topics: [...input.topics] } },
    { reportFailure: false },
  ).then((result) => (result._tag === "Success" ? result.value : null));
  return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}

/**
 * Before a push is shown in front: whether the Kin host already settled what it is about, as
 * happens when it was held up on its way. Not a Kin push of the current host: false, at once.
 */
export function kinPushSettledNow(notification: unknown): Promise<boolean> {
  const host = appAtomRegistry.get(kinHostAtom);
  if (host._tag !== "host") return Promise.resolve(false);
  return kinIncomingSettled(notification, host.environmentId, (input) =>
    askHost(host.environmentId, input),
  ).catch(() => false);
}

/**
 * Asks the host once which of its delivered notifications are settled and removes those, healing
 * a withdrawal the OS never woke the app for. `incoming` are pushes that just arrived, which the
 * tray may not list yet. Nothing delivered from it, nothing to ask.
 */
async function reconcileWithHost(
  environmentId: EnvironmentId,
  incoming: ReadonlyArray<unknown>,
): Promise<void> {
  const listed = await Notifications.getPresentedNotificationsAsync();
  const ids = new Set(listed.map((one) => one.request.identifier));
  const presented = [
    ...listed,
    ...incoming.filter(
      (one) =>
        !ids.has(String((one as { request?: { identifier?: unknown } }).request?.identifier)),
    ),
  ];
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
      kinReconcileRemovals(presented, { environmentId, orgId }, result.value, Date.now()).map(
        (identifier) => Notifications.dismissNotificationAsync(identifier),
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
  // Once per coming to the front, when the host first answers; again whenever a push arrives,
  // with that push in the ask, or the inbox settles something. Calls during a check make one more.
  let reconciled = false;
  const arrivals: Array<unknown> = [];
  const reconcileOnce = kinCoalesced(async () => {
    const incoming = arrivals.splice(0);
    if (environmentId === null) return;
    await reconcileWithHost(environmentId, incoming).catch(
      warn("Reconciling Kin notifications failed"),
    );
  });

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
        const before = inbox;
        inbox = result.value.value;
        reconcile();
        if (!reconciled || (before !== null && kinInboxSettledSince(before, inbox))) {
          reconciled = true;
          reconcileOnce();
        }
      },
      { immediate: true },
    );
  };

  const unsubscribeHost = appAtomRegistry.subscribe(kinHostAtom, sync, { immediate: true });
  const appState = AppState.addEventListener("change", sync);
  const arrived = Notifications.addNotificationReceivedListener((notification) => {
    arrivals.push(notification);
    reconcileOnce();
  });
  return () => {
    unsubscribeHost();
    appState.remove();
    arrived.remove();
    unsubscribeInbox?.();
  };
}
