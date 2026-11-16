import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import { kinClearedChat, kinSettledNotificationIds } from "./kinPushPayload";

const KIN_CLEAR_TASK = "kin-clear-read-chat";

/**
 * A chat read on another device or the web arrives as a badge push that wakes the app; this takes
 * that chat's banners off the pane while the app stays in the background. iOS may skip such wakes,
 * so the foreground reconcile in `kinNotificationSync` still clears what this missed.
 */
export function defineKinBackgroundClear(): void {
  if (Platform.OS !== "ios") return;
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    KIN_CLEAR_TASK,
    async ({ data }) => {
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
