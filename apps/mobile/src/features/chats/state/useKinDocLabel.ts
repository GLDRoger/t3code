import { useAtomValue } from "@effect/atom-react";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { kinDocLabelAction } from "@t3tools/client-runtime/kin/kinTemplates";
import type { KinDocDetail } from "@t3tools/contracts";
import { useState } from "react";

import * as Dialog from "../../../components/ui/Dialog";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/** Raising or lowering a doc's private label from its menu, after a yes, and any refusal. */
export function useKinDocLabel(target: KinWorkTarget, doc: KinDocDetail) {
  const allowed = useAtomValue(kinClient.docLabel.permissionAtom(target.environmentId));
  const send = useAtomCommand(kinClient.docLabel, { reportFailure: false });
  const [problem, setProblem] = useState<string | null>(null);
  const action = allowed ? kinDocLabelAction(doc) : null;
  const apply = async () => {
    if (action === null) return;
    setProblem(null);
    const sent = await kinListSend({
      online: () => kinHostConnected(target.environmentId),
      send: () =>
        send({
          environmentId: target.environmentId,
          input: { orgId: target.orgId, key: doc.key, sensitive: action.sensitive },
        }),
    });
    if (!sent.ok) setProblem(sent.problem);
  };
  return {
    action,
    problem,
    dismiss: () => setProblem(null),
    ask: () =>
      action === null
        ? undefined
        : Dialog.confirm({
            title: action.title,
            message: action.detail,
            confirmText: action.label,
            onConfirm: () => void apply(),
          }),
  };
}
