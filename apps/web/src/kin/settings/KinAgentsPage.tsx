import { useAtomValue } from "@effect/atom-react";
import { kinAgentGroups } from "@t3tools/client-runtime/kin/kinAgentRetire";
import { kinDomainLabel, KIN_AGENTS_COPY } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { KinAgentDefaultsSetting } from "../KinAgentsSetting";
import { KinAvatar } from "../KinAvatar";
import { kinClient } from "../kinClient";
import { openKinLeadForm } from "../KinNewLeadButton";
import { withKinAgentPage } from "../kinPlaces";
import { useKinWorkingAgents } from "../useKinHost";
import type { KinSettingsTarget } from "./kinSettingsTarget";

/** The agents, each opening its chat (where its sheet is), and a way to add another. */
export function KinAgentsPage(props: KinSettingsTarget) {
  const { environmentId, orgId } = props;
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const working = useKinWorkingAgents(environmentId);
  const canAdd = useAtomValue(kinClient.leadCreate.permissionAtom(environmentId));
  const all = Option.getOrNull(AsyncResult.value(result))?.leads ?? null;
  const agents = all === null ? null : kinAgentGroups(all).active;
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4 sm:p-6">
      {canAdd ? (
        <Button
          size="sm"
          className="self-end"
          onClick={() => openKinLeadForm({ ...props, lead: null })}
        >
          New agent
        </Button>
      ) : null}
      {agents === null ? (
        <p className="text-sm text-muted-foreground">
          {AsyncResult.isFailure(result) ? KIN_AGENTS_COPY.loadFailed : "Loading…"}
        </p>
      ) : agents.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>{KIN_AGENTS_COPY.noneTitle}</EmptyTitle>
            <EmptyDescription>{KIN_AGENTS_COPY.explain}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {agents.map((agent) => (
            <li key={agent.agentId}>
              <Link
                // Over the Kin page under Settings, which closes as the agent's page opens.
                to="."
                search={(prev) => withKinAgentPage(prev, agent.agentId)}
                className="flex items-center gap-3 px-3 py-2.5 outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <KinAvatar avatar={kinAgentAvatar(agent.agentId)} size="xs" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {kinDomainLabel(agent.domain)}
                  </span>
                </span>
                {working.has(agent.agentId) ? (
                  <span className="text-xs text-muted-foreground">Working</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Open an agent to see its page.</p>
      <KinAgentDefaultsSetting {...props} />
    </div>
  );
}
