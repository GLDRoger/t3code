import { useAtomValue } from "@effect/atom-react";
import { KIN_DOCS } from "@t3tools/client-runtime/kin/kinDocs";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import type { KinRecordKey } from "@t3tools/contracts";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Delete and Restore on a doc. Delete asks nothing first: the doc leaves Docs and a toast offers
 * Undo. `allowed` is this session's; whether this person may is the doc's `deletable`.
 */
export function useKinDocDelete(target: KinWorkTarget) {
  const { environmentId, orgId } = target;
  const allowed = useAtomValue(kinClient.docDelete.permissionAtom(environmentId));
  const send = useAtomCommand(kinClient.docDelete, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);

  const set = async (doc: { readonly key: KinRecordKey }, deleted: boolean) => {
    setBusy(doc.key);
    const sent = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => send({ environmentId, input: { orgId, key: doc.key, deleted } }),
    });
    setBusy(null);
    return sent;
  };

  /** Brings it back; says so, or why not, in a toast. */
  const restore = async (doc: { readonly key: KinRecordKey; readonly title: string }) => {
    const sent = await set(doc, false);
    toastManager.add(
      sent.ok
        ? { type: "success", title: KIN_DOCS.restoredDoc(doc.title) }
        : {
            type: "error",
            title: KIN_DOCS.restoreDocFailed,
            description: sent.problem,
          },
    );
    return sent.ok;
  };

  /** Deletes it; on success `onDeleted` runs and a toast offers Undo. False, with why, when not. */
  const remove = async (
    doc: { readonly key: KinRecordKey; readonly title: string },
    onDeleted: () => void,
  ) => {
    if (!kinHostConnected(environmentId))
      return { ok: false as const, problem: KIN_DOCS.deleteOffline };
    const sent = await set(doc, true);
    if (!sent.ok)
      return { ok: false as const, problem: `${KIN_DOCS.deleteFailed} ${sent.problem}` };
    onDeleted();
    const toast = toastManager.add({
      type: "success",
      timeout: 10_000,
      title: KIN_DOCS.deletedNotice(doc.title),
      actionProps: {
        children: KIN_DOCS.undo,
        onClick: () => {
          toastManager.close(toast);
          void restore(doc);
        },
      },
    });
    return { ok: true as const };
  };

  return { allowed, busy, remove, restore };
}
