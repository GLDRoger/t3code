import { useAtomValue } from "@effect/atom-react";
import {
  KIN_TEAM_AGENT_COPY,
  kinTeamAgentChoices,
  kinTeamAgentLabel,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { KinAgentId, type EnvironmentId, type KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

const OFF = "off";

/** The agent everyone on the team can chat with, or off. The Team page's top row, owner only. */
export function KinTeamAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const set = useAtomCommand(kinClient.teamAgentSet, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const held = Option.getOrNull(AsyncResult.value(result));
  if (held === null) return null;
  const choices = kinTeamAgentChoices(held.leads);
  const current = held.teamAgentId ?? null;
  const shown = pending ?? current ?? OFF;
  const label =
    pending === null
      ? kinTeamAgentLabel(held.leads, current)
      : (choices.find((choice) => (choice.agentId ?? OFF) === pending)?.label ?? "");
  const pick = async (value: string) => {
    if (value === (current ?? OFF)) return;
    setPending(value);
    setProblem(null);
    const outcome = await set({
      environmentId,
      input: { orgId, agentId: value === OFF ? null : KinAgentId.make(value) },
    });
    setPending(null);
    if (!AsyncResult.isSuccess(outcome)) setProblem(KIN_TEAM_AGENT_COPY.failed);
  };
  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-3">
        <SparklesIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
          {KIN_TEAM_AGENT_COPY.label}
        </span>
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" aria-busy={pending !== null} />}>
            {label}
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            <MenuRadioGroup value={shown} onValueChange={(value) => void pick(String(value))}>
              {choices.map((choice) => (
                <MenuRadioItem key={choice.agentId ?? OFF} value={choice.agentId ?? OFF}>
                  <span className="flex min-w-0 items-center justify-between gap-4">
                    <span className="truncate">{choice.label}</span>
                    {choice.suggested ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {KIN_TEAM_AGENT_COPY.suggested}
                      </span>
                    ) : null}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      </div>
      <p className="ps-7 text-xs text-muted-foreground">{KIN_TEAM_AGENT_COPY.detail}</p>
      {problem === null ? null : (
        <p role="alert" className="ps-7 text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </section>
  );
}
