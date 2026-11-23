import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import {
  kinClearedChat,
  kinSettledNotificationIds,
  kinWithdrawal,
  kinWithdrawnIds,
} from "./kinPushPayload";

const KIN_CLEAR_TASK = "kin-clear-read-chat";

/**
 * A host withdrawing what is settled, or (from an older host) a chat read elsewhere, arrives as a
 * silent push (on Android, a data message) that wakes the app; this takes those notifications off
 * the pane while the app stays in the background. Either OS may skip such wakes, so the reconcile
 * in `kinNotificationSync` clears what this missed when the app next comes to the front.
 */
export function defineKinBackgroundClear(): void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    KIN_CLEAR_TASK,
    async ({ data }) => {
      const withdrawal = kinWithdrawal(data);
      if (withdrawal !== null) {
        const presented = await Notifications.getPresentedNotificationsAsync();
        await Promise.all(
          kinWithdrawnIds(presented, withdrawal, withdrawal.withdraw).map((identifier) =>
            Notifications.dismissNotificationAsync(identifier),
          ),
        );
        if (Platform.OS === "ios" && withdrawal.badge !== undefined)
          await Notifications.setBadgeCountAsync(withdrawal.badge);
        return Notifications.BackgroundNotificationTaskResult.NewData;
      }
      const cleared = kinClearedChat(data);
      if (cleared === null) return Notifications.BackgroundNotificationTaskResult.NoData;
      const presented = await Notifications.getPresentedNotificationsAsync();
      await Promise.all(
        kinSettledNotificationIds(
          presented,
          cleared.environmentId,
          (id) => id === cleared.chatId,
        ).map((identifier) => Notifications.dismissNotificationAsync(identifier)),
      );
      return Notifications.BackgroundNotificationTaskResult.NewData;
    },
  );
  void Notifications.registerTaskAsync(KIN_CLEAR_TASK).catch((cause: unknown) =>
    console.warn("Registering Kin's background clear failed", cause),
  );
}
