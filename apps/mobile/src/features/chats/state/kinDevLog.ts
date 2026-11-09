import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "./kinClient";
import { selectKinInboxView } from "./kinInboxModel";
import { kinHostAtom } from "./useKinHost";

/** Dev only: logs the Kin host and its inbox snapshot until MOB-2 adds screens. */
export function installKinDevLog(): () => void {
  let stopInbox: (() => void) | null = null;
  let inboxHost: string | null = null;
  const stopHost = appAtomRegistry.subscribe(
    kinHostAtom,
    (host) => {
      console.log("[kin] host", host._tag === "host" ? { ...host, probe: host.probe._tag } : host);
      const environmentId = host._tag === "host" ? host.environmentId : null;
      if (environmentId === inboxHost) return;
      stopInbox?.();
      stopInbox = null;
      inboxHost = environmentId;
      if (environmentId === null) return;
      stopInbox = appAtomRegistry.subscribe(
        kinClient.inbox({ environmentId, input: {} }),
        (result) => {
          if (result._tag === "Failure") {
            console.log("[kin] inbox failed", Cause.pretty(result.cause));
            return;
          }
          if (!AsyncResult.isSuccess(result)) return;
          const view = selectKinInboxView(result.value.value);
          console.log("[kin] inbox", {
            live: result.value.live,
            savedAt: result.value.savedAt,
            unread: view.unreadCount,
            waiting: view.waitingCount,
            chats: view.rows.map((row) => ({
              chatId: row.chat.chatId,
              title: row.chat.title,
              unread: row.chat.unread,
              waiting: row.waitingCount,
            })),
          });
        },
        { immediate: true },
      );
    },
    { immediate: true },
  );
  return () => {
    stopInbox?.();
    stopHost();
  };
}
