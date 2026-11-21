import { useAtomValue } from "@effect/atom-react";
import type {
  KinImportApplied,
  KinImportApplyInput,
  KinImportCheck,
  KinImportCheckInput,
  KinImportUndone,
} from "@t3tools/contracts";

import { kinListSend, type KinListOutcome } from "../kinLists.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import type { KinHookApp } from "./kinHookApp.ts";

/** Past imports, and checking, bringing in and taking away a file, on one app's client. */
export function makeKinImportHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, registry, useAtomCommand, kinHostConnected } = app;
  const runsAtom = (target: KinScreenTarget) =>
    kinClient.importRuns({ environmentId: target.environmentId, input: { orgId: target.orgId } });

  /** The batches brought in before, newest first; read again after an import or an undo. */
  function useKinImportRuns(target: KinScreenTarget) {
    const atom = runsAtom(target);
    return {
      state: kinWorkReadState(useAtomValue(atom)),
      refresh: () => registry.refresh(atom),
    };
  }

  /** Check a file, import it, take a batch away: each answered by the host or a reason in words. */
  function useKinImportSend(target: KinScreenTarget) {
    const { environmentId, orgId } = target;
    const check = useAtomCommand(kinClient.importCheck, { reportFailure: false });
    const apply = useAtomCommand(kinClient.importApply, { reportFailure: false });
    const undo = useAtomCommand(kinClient.importUndo, { reportFailure: false });
    const online = () => kinHostConnected(environmentId);
    const reread = () => registry.refresh(runsAtom(target));
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

  return { useKinImportRuns, useKinImportSend };
}
