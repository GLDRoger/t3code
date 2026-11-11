import {
  kinRestoreCopy,
  kinRestoreProblem,
  kinRetireCopy,
  kinRetireProblem,
  kinRetiredWhen,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinAgentId, KinOrgId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import * as Dialog from "../../../components/ui/Dialog";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient, refreshKinAgents } from "./kinClient";

/** Read at render: the day it names only changes at midnight, and a re-render reads it again. */
export const kinRetiredWhenNow = (at: string | undefined) => kinRetiredWhen(at, Date.now());

export interface KinAgentTarget {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly name: string;
}

/**
 * Retire and restore, each after one plain confirmation. A refusal is said in the owner's terms,
 * and the same row is the retry. `busy` names the agent being changed.
 */
export function useKinAgentRetire(environmentId: EnvironmentId) {
  const runRetire = useAtomCommand(kinClient.leadRetire, { reportFailure: false });
  const runRestore = useAtomCommand(kinClient.leadRestore, { reportFailure: false });
  const [busy, setBusy] = useState<KinAgentId | null>(null);

  const change = async (agent: KinAgentTarget, retiring: boolean, onDone?: () => void) => {
    if (busy !== null) return;
    setBusy(agent.agentId);
    const input = { orgId: agent.orgId, agentId: agent.agentId };
    const result = await (retiring ? runRetire : runRestore)({ environmentId, input });
    setBusy(null);
    // Read again either way: a refusal usually means the list this screen holds is behind.
    refreshKinAgents(environmentId, agent.orgId);
    if (AsyncResult.isSuccess(result)) return onDone?.();
    const cause = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
    Dialog.alert(
      retiring ? `${agent.name} wasn't retired` : `${agent.name} wasn't restored`,
      retiring ? kinRetireProblem(cause, agent.name) : kinRestoreProblem(cause, agent.name),
    );
  };

  return {
    busy,
    retire: (agent: KinAgentTarget, onDone?: () => void) => {
      const copy = kinRetireCopy(agent.name);
      Dialog.confirm({
        title: copy.title,
        message: copy.detail,
        confirmText: copy.confirm,
        destructive: true,
        onConfirm: () => void change(agent, true, onDone),
      });
    },
    restore: (agent: KinAgentTarget, onDone?: () => void) => {
      const copy = kinRestoreCopy(agent.name);
      Dialog.confirm({
        title: copy.title,
        message: copy.detail,
        confirmText: copy.confirm,
        onConfirm: () => void change(agent, false, onDone),
      });
    },
  };
}
