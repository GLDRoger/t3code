import { useAtomValue } from "@effect/atom-react";
import type { KinRecordKey } from "@t3tools/contracts";
import { useState } from "react";

import { KIN_DOCS } from "../kinDocs.ts";
import { kinListSend } from "../kinLists.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import type { KinHookApp } from "./kinHookApp.ts";

/**
 * Delete and Restore on a doc: Delete asks nothing first, since Undo brings it back as it was.
 * `allowed` is this session's; whether this person may is the doc's `deletable`.
 */
export function makeKinDocDeleteHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, useAtomCommand, kinHostConnected } = app;

  function useKinDocDelete(target: KinScreenTarget) {
    const { environmentId, orgId } = target;
    const allowed = useAtomValue(kinClient.docDelete.permissionAtom(environmentId));
    const send = useAtomCommand(kinClient.docDelete, { reportFailure: false });
    const [busy, setBusy] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    /** The doc just deleted here, whose line or toast offers Undo. */
    const [justDeleted, setJustDeleted] = useState<string | null>(null);

    /** Null when it went through; else why not, also held as `problem`. */
    const set = async (key: KinRecordKey, deleted: boolean): Promise<string | null> => {
      setProblem(null);
      if (!kinHostConnected(environmentId)) {
        setProblem(KIN_DOCS.deleteOffline);
        return KIN_DOCS.deleteOffline;
      }
      setBusy(key);
      const sent = await kinListSend({
        online: () => kinHostConnected(environmentId),
        send: () => send({ environmentId, input: { orgId, key, deleted } }),
      });
      setBusy(null);
      if (!sent.ok) {
        const why = `${deleted ? KIN_DOCS.deleteFailed : KIN_DOCS.restoreDocFailed} ${sent.problem}`;
        setProblem(why);
        return why;
      }
      setJustDeleted(deleted ? key : null);
      return null;
    };

    return {
      allowed,
      busy,
      problem,
      justDeleted,
      dismiss: () => setProblem(null),
      remove: (key: KinRecordKey) => set(key, true),
      restore: (key: KinRecordKey) => set(key, false),
    };
  }

  return { useKinDocDelete };
}
