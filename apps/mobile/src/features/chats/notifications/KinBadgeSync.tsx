import { kinBadgeCount, type KinInboxState } from "@t3tools/client-runtime/kin/kinInboxModel";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";

/**
 * Keeps the app icon's badge in step with the inbox while a chat is open, so reading a chat
 * clears what the host's last push counted. Pushes set it again whenever the app is closed.
 */
export function KinBadgeSync(props: { readonly inbox: KinInboxState | null }) {
  const count = props.inbox === null ? null : kinBadgeCount(props.inbox);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the icon badge lives in the OS, outside React
  useEffect(() => {
    if (count === null || Platform.OS !== "ios") return;
    void Notifications.setBadgeCountAsync(count).catch((cause: unknown) =>
      console.warn("Setting the Kin badge failed", cause),
    );
  }, [count]);
  return null;
}
