import { useAtomValue } from "@effect/atom-react";
import { kinListSend, type KinListOutcome } from "@t3tools/client-runtime/kin/kinLists";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinImportApplied,
  KinImportApplyInput,
  KinImportCheck,
  KinImportCheckInput,
  KinImportUndone,
} from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

const runsAtom = (target: KinWorkTarget) =>
  kinClient.importRuns({ environmentId: target.environmentId, input: { orgId: target.orgId } });

/** The batches brought in before, newest first; read again after an import or an undo. */
export function useKinImportRuns(target: KinWorkTarget) {
  const atom = runsAtom(target);
  return {
    state: kinWorkReadState(useAtomValue(atom)),
    refresh: () => appAtomRegistry.refresh(atom),
  };
}

/** Check a file, import it, take a batch away: each answered by the host or a reason in words. */
export function useKinImportSend(target: KinWorkTarget) {
  const { environmentId, orgId } = target;
  const check = useAtomCommand(kinClient.importCheck, { reportFailure: false });
  const apply = useAtomCommand(kinClient.importApply, { reportFailure: false });
  const undo = useAtomCommand(kinClient.importUndo, { reportFailure: false });
  const online = () => kinHostConnected(environmentId);
  const reread = () => appAtomRegistry.refresh(runsAtom(target));
  return {
    check: (input: Omit<KinImportCheckInput, "orgId">): Promise<KinListOutcome<KinImportCheck>> =>
      kinListSend({ online, send: () => check({ environmentId, input: { ...input, orgId } }) }),
    apply: async (
      input: Omit<KinImportApplyInput, "orgId">,
    ): Promise<KinListOutcome<KinImportApplied>> => {
      const outcome = await kinListSend({
        online,
        send: () => apply({ environmentId, input: { ...input, orgId } }),
      });
      if (outcome.ok) reread();
      return outcome;
    },
    undo: async (batch: string): Promise<KinListOutcome<KinImportUndone>> => {
      const outcome = await kinListSend({
        online,
        send: () => undo({ environmentId, input: { orgId, batch } }),
      });
      if (outcome.ok) reread();
      return outcome;
    },
  };
}
