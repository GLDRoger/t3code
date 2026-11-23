import type { KinChatListRow } from "@t3tools/client-runtime/kin/kinChatListRows";
import {
  kinSettledAlertChats,
  type KinShownAlert,
} from "@t3tools/client-runtime/kin/kinMessageAlerts";

// The system alert this window raised for each host's chat; a newer one replaces it by its tag.
const shown = new Map<string, KinShownAlert & { readonly alert: Notification }>();

const keyOf = (environmentId: string, chatId: string) => `${environmentId}\0${chatId}`;

/** The system alert's tag: one per host and chat, so two hosts' chats never replace each other. */
export const kinAlertTag = (environmentId: string, chatId: string) =>
  `kin:${environmentId}:${chatId}`;

export function keepKinAlert(environmentId: string, chatId: string, alert: Notification): void {
  const key = keyOf(environmentId, chatId);
  shown.set(key, { environmentId, chatId, alert });
  alert.addEventListener("close", () => {
    if (shown.get(key)?.alert === alert) shown.delete(key);
  });
}

/** Takes down this host's alerts of chats read on any device, as the phone's are withdrawn. */
export function closeSettledKinAlerts(
  environmentId: string,
  rows: ReadonlyArray<KinChatListRow>,
): void {
  for (const settled of kinSettledAlertChats(shown.values(), environmentId, rows)) {
    settled.alert.close();
    shown.delete(keyOf(settled.environmentId, settled.chatId));
  }
}
