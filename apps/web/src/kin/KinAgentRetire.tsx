import {
  KIN_RESTORE_ACTION,
  KIN_RETIRE_ACTION,
  kinRestoreProblem,
  kinRetireCopy,
  kinRetireOffer,
  kinRetireProblem,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinAgentId, KinOrgId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient, refreshKinAgents } from "./kinClient";

export interface KinAgentTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly name: string;
}

/**
 * Restore, wherever a retired agent shows. A refusal reads under the button and the button stays,
 * so the same press is the retry.
 */
export function KinRestoreAgent(props: { readonly agent: KinAgentTarget }) {
  const { busy, problem, run } = useKinRestore(props.agent);
  return (
    <>
      <KinRestoreButton agent={props.agent} busy={busy} onRestore={run} />
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </>
  );
}

export function KinRestoreButton(props: {
  readonly agent: KinAgentTarget;
  readonly busy: boolean;
  readonly onRestore: () => void;
  readonly quiet?: boolean;
}) {
  return (
    <Button
      size={props.quiet === true ? "xs" : "sm"}
      variant={props.quiet === true ? "ghost" : "outline"}
      disabled={props.busy}
      aria-busy={props.busy}
      aria-label={`Restore ${props.agent.name}`}
      onClick={props.onRestore}
    >
      {props.busy ? "Restoring…" : KIN_RESTORE_ACTION}
    </Button>
  );
}

/** One restore at a time for an agent, and why the last one was refused. */
export function useKinRestore(agent: KinAgentTarget) {
  const restore = useAtomCommand(kinClient.leadRestore, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await restore({
      environmentId: agent.environmentId,
      input: { orgId: agent.orgId, agentId: agent.agentId },
    });
    setBusy(false);
    // Read again either way: a refusal usually means the list this screen holds is behind.
    refreshKinAgents(agent.environmentId, agent.orgId);
    if (AsyncResult.isSuccess(result)) return;
    setProblem(
      kinRestoreProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
        agent.name,
      ),
    );
  };
  return { busy, problem, run: () => void run() };
}

/**
 * Retire, with its one confirmation. On the owner's only active agent it says why there is no
 * button instead, since the host would refuse.
 */
export function KinRetireAgent(props: {
  readonly agent: KinAgentTarget;
  /** How many of the owner's agents are active, this one included. */
  readonly activeAgents: number;
}) {
  const { agent } = props;
  const retire = useAtomCommand(kinClient.leadRetire, { reportFailure: false });
  const [state, setState] = useState<"idle" | "confirm" | "retiring">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const offer = kinRetireOffer(agent, props.activeAgents);
  const copy = kinRetireCopy(agent.name);

  const run = async () => {
    setState("retiring");
    setProblem(null);
    const result = await retire({
      environmentId: agent.environmentId,
      input: { orgId: agent.orgId, agentId: agent.agentId },
    });
    setState("idle");
    // Read again either way: a refusal usually means the list this screen holds is behind.
    refreshKinAgents(agent.environmentId, agent.orgId);
    if (AsyncResult.isSuccess(result)) return;
    setProblem(
      kinRetireProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
        agent.name,
      ),
    );
  };

  if (!offer.offered) return <p className="text-xs text-muted-foreground">{offer.why}</p>;
  return (
    <>
      <Button
        size="sm"
        variant="destructive-outline"
        className="self-start"
        disabled={state === "retiring"}
        aria-busy={state === "retiring"}
        onClick={() => setState("confirm")}
      >
        {state === "retiring" ? "Retiring…" : KIN_RETIRE_ACTION}
      </Button>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      <AlertDialog
        open={state === "confirm"}
        onOpenChange={(open) => {
          if (!open) setState((held) => (held === "confirm" ? "idle" : held));
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void run()}>
              {copy.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
