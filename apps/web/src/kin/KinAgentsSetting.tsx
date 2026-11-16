import { useAtomValue } from "@effect/atom-react";
import { KIN_AGENT_PAGE } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinDomainLabel } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { KinAgentModels, KinLeadProfile } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { useOpenKinAgentPage } from "./KinAgentPage";
import { KinAgentModelPicker } from "./KinAgentModelPicker";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import type { KinWorkTarget } from "./useKinWork";

/** The company's agents and the models new ones start on, for the owner and co-owners. */
export function KinAgentsSetting() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <OwnerLevelAgents {...target} />;
}

function OwnerLevelAgents(props: KinWorkTarget) {
  if (!useKinOwnerLevel(props.environmentId)) return null;
  return (
    <SettingsSection {...searchableSetting("kin-agents")}>
      <CompanyDefault {...props} />
      <AgentRows {...props} />
    </SettingsSection>
  );
}

/** The models new agents start on; the owner and co-owners change it. */
export function KinAgentDefaultsSetting(props: KinWorkTarget) {
  if (!useKinOwnerLevel(props.environmentId)) return null;
  return (
    <SettingsSection {...searchableSetting("kin-agents")}>
      <CompanyDefault {...props} />
    </SettingsSection>
  );
}

function CompanyDefault(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const defaultsAtom = kinClient.agentDefaults({ environmentId, input: { orgId } });
  const defaults = Option.getOrNull(AsyncResult.value(useAtomValue(defaultsAtom)));
  const save = useAtomCommand(kinClient.agentDefaultsSet, { reportFailure: false });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = defaults?.models ?? null;

  const choose = async (models: KinAgentModels) => {
    setBusy(true);
    const outcome = await save({ environmentId, input: { orgId, models } });
    setBusy(false);
    setProblem(
      AsyncResult.isFailure(outcome)
        ? kinFailureText(squashAtomCommandFailure(outcome), "Couldn't save that.")
        : null,
    );
    appAtomRegistry.refresh(defaultsAtom);
  };

  return (
    <SettingsRow
      title={KIN_AGENT_PAGE.defaults}
      description={
        problem === null ? (
          `${KIN_AGENT_PAGE.defaultsDetail}${defaults?.chosen === false ? " Until you choose, they start on your first agent's." : ""}`
        ) : (
          <span role="alert">{problem}</span>
        )
      }
      control={
        base === null ? undefined : (
          <div className="flex flex-col items-end gap-1.5">
            {(["strong", "cheap"] as const).map((role) => (
              <KinAgentModelPicker
                key={role}
                environmentId={environmentId}
                label={`${KIN_AGENT_PAGE.defaults}: ${KIN_AGENT_PAGE[role].toLowerCase()}`}
                selection={base[role]}
                disabled={busy}
                onChange={(selection) => void choose({ ...base, [role]: selection })}
              />
            ))}
          </div>
        )
      }
    />
  );
}

function AgentRows(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const openPage = useOpenKinAgentPage();
  const leads = Option.getOrNull(AsyncResult.value(useAtomValue(kinClient.agents(props))));
  if (leads === null) return null;
  const open = (lead: KinLeadProfile) =>
    openPage({ environmentId, orgId, agentId: lead.agentId, chatId: lead.ownerChatId });
  return leads.leads.map((lead) => (
    <SettingsRow
      key={lead.agentId}
      title={
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-3 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => void open(lead)}
        >
          <KinAvatar avatar={kinAgentAvatar(lead.agentId)} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{lead.name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {[
                kinDomainLabel(lead.domain),
                lead.retired !== undefined ? "Retired" : null,
                lead.paused !== undefined ? "Paused" : null,
                lead.agentId === leads.teamAgentId ? "Team agent" : null,
              ]
                .filter((part) => part !== null)
                .join(", ")}
            </span>
          </span>
          <ChevronRightIcon className="ms-auto size-4 text-muted-foreground" />
        </button>
      }
    />
  ));
}
