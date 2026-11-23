import type { KinChatListRow } from "@t3tools/client-runtime/kin/kinChatListRows";
import { kinSettledAlertChats } from "@t3tools/client-runtime/kin/kinMessageAlerts";

// The system alert this window raised for each chat; a newer one replaces it by its tag.
const shown = new Map<string, Notification>();

export function keepKinAlert(chatId: string, alert: Notification): void {
  shown.set(chatId, alert);
  alert.addEventListener("close", () => {
    if (shown.get(chatId) === alert) shown.delete(chatId);
  });
}

/** Takes down the alerts of chats read on any device, as the phone's notifications are withdrawn. */
export function closeSettledKinAlerts(rows: ReadonlyArray<KinChatListRow>): void {
  for (const chatId of kinSettledAlertChats(shown.keys(), rows)) {
    shown.get(chatId)?.close();
    shown.delete(chatId);
  }
}
