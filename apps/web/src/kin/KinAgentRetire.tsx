import { useAtomValue } from "@effect/atom-react";
import {
  KIN_RESTORE_ACTION,
  KIN_RETIRE_ACTION,
  KIN_RETIRE_NEXT_TEAM_AGENT,
  kinNextTeamAgentChoices,
  kinRestoreProblem,
  kinRetireCopy,
  kinRetireOffer,
  kinRetireProblem,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon } from "lucide-react";
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
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
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
  const list = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        kinClient.leads({ environmentId: agent.environmentId, input: { orgId: agent.orgId } }),
      ),
    ),
  );
  const [state, setState] = useState<"idle" | "confirm" | "retiring">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [next, setNext] = useState<KinAgentId | null>(null);
  const offer = kinRetireOffer(agent, props.activeAgents);
  const copy = kinRetireCopy(agent.name);
  const nextChoices = list === null ? null : kinNextTeamAgentChoices(list, agent.agentId);
  const nextName = nextChoices?.find((lead) => lead.agentId === next)?.name ?? null;

  const run = async () => {
    setState("retiring");
    setProblem(null);
    const result = await retire({
      environmentId: agent.environmentId,
      input: {
        orgId: agent.orgId,
        agentId: agent.agentId,
        ...(nextChoices === null || next === null ? {} : { nextTeamAgentId: next }),
      },
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
          {nextChoices === null ? null : (
            <div className="flex items-center justify-between gap-3 px-6 pb-4">
              <span className="text-sm font-medium text-foreground">
                {KIN_RETIRE_NEXT_TEAM_AGENT}
              </span>
              <Menu>
                <MenuTrigger render={<Button size="sm" variant="outline" />}>
                  {nextName ?? "Choose an agent"}
                  <ChevronDownIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom">
                  <MenuRadioGroup
                    value={next ?? ""}
                    onValueChange={(value) =>
                      setNext(nextChoices.find((lead) => lead.agentId === value)?.agentId ?? null)
                    }
                  >
                    {nextChoices.map((lead) => (
                      <MenuRadioItem key={lead.agentId} value={lead.agentId}>
                        {lead.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={nextChoices !== null && nextName === null}
              onClick={() => void run()}
            >
              {copy.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
