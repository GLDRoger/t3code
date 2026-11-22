import { useAtomValue } from "@effect/atom-react";
import { KIN_DOCS } from "@t3tools/client-runtime/kin/kinDocs";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import type { KinRecordKey } from "@t3tools/contracts";
import { useState } from "react";

import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Delete and Restore on a doc: Delete asks nothing first, since Undo brings it back as it was.
 * `allowed` is this session's; whether this person may is the doc's `deletable`.
 */
export function useKinDocDelete(target: KinWorkTarget) {
  const { environmentId, orgId } = target;
  const allowed = useAtomValue(kinClient.docDelete.permissionAtom(environmentId));
  const send = useAtomCommand(kinClient.docDelete, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The doc this screen just deleted, whose line offers Undo. */
  const [justDeleted, setJustDeleted] = useState<string | null>(null);

  const set = async (key: KinRecordKey, deleted: boolean) => {
    setProblem(null);
    if (!kinHostConnected(environmentId)) {
      setProblem(KIN_DOCS.deleteOffline);
      return false;
    }
    setBusy(key);
    const sent = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => send({ environmentId, input: { orgId, key, deleted } }),
    });
    setBusy(null);
    if (!sent.ok)
      setProblem(`${deleted ? KIN_DOCS.deleteFailed : KIN_DOCS.restoreDocFailed} ${sent.problem}`);
    else setJustDeleted(deleted ? key : null);
    return sent.ok;
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
