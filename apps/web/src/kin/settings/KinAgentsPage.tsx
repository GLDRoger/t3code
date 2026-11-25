import { useAtomValue } from "@effect/atom-react";
import { kinAgentGroups } from "@t3tools/client-runtime/kin/kinAgentRetire";
import {
  KIN_AGENTS_COPY,
  KIN_AGENTS_PAGE,
  kinAgentRowLine,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { KinAgentDefaultsSections } from "../KinAgentsSetting";
import { KinAvatar } from "../KinAvatar";
import { kinClient } from "../kinClient";
import { openKinLeadForm } from "../KinNewLeadButton";
import { withKinAgentPage } from "../kinPlaces";
import { useKinWorkingAgents } from "../useKinHost";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./KinSettingsLayout";
import type { KinSettingsTarget } from "./kinSettingsTarget";

/** The agents, each opening its page, a way to add another, and what new ones start on. */
export function KinAgentsPage(props: KinSettingsTarget) {
  const { environmentId, orgId } = props;
  const atom = kinClient.leads({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const working = useKinWorkingAgents(environmentId, orgId);
  const canAdd = useAtomValue(kinClient.leadCreate.permissionAtom(environmentId));
  const navigate = useNavigate();
  const all = Option.getOrNull(AsyncResult.value(result))?.leads ?? null;
  const agents = all === null ? null : kinAgentGroups(all).active;
  return (
    <KinSettingsPage
      purpose={KIN_AGENTS_PAGE.purpose}
      action={
        canAdd ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openKinLeadForm({ ...props, lead: null })}
          >
            <PlusIcon />
            {KIN_AGENTS_PAGE.add}
          </Button>
        ) : undefined
      }
    >
      <KinSettingsSection>
        {agents === null ? (
          AsyncResult.isFailure(result) ? (
            <KinSettingsLoadFailed onRetry={() => appAtomRegistry.refresh(atom)}>
              {KIN_AGENTS_COPY.loadFailed}
            </KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={2} />
          )
        ) : agents.length === 0 ? (
          <KinSettingsEmpty>{KIN_AGENTS_COPY.explain}</KinSettingsEmpty>
        ) : (
          agents.map((agent) => (
            <KinSettingsRow
              key={agent.agentId}
              leading={<KinAvatar avatar={kinAgentAvatar(agent.agentId)} size="sm" />}
              title={agent.name}
              detail={kinAgentRowLine(agent)}
              status={
                agent.paused !== undefined ? (
                  <KinSettingsStatus tone="quiet">{KIN_AGENTS_PAGE.paused}</KinSettingsStatus>
                ) : working.has(agent.agentId) ? (
                  <KinSettingsStatus tone="quiet">{KIN_AGENTS_PAGE.working}</KinSettingsStatus>
                ) : null
              }
              openLabel={KIN_AGENTS_PAGE.open(agent.name)}
              // Over the Kin page under Settings, which closes as the agent's page opens.
              onOpen={() =>
                void navigate({
                  to: ".",
                  search: (prev) => withKinAgentPage(prev, agent.agentId),
                })
              }
            />
          ))
        )}
      </KinSettingsSection>
      <KinAgentDefaultsSections {...props} />
    </KinSettingsPage>
  );
}
