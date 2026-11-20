import { useAtomValue } from "@effect/atom-react";
import { KIN_AGENT_PAGE } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_AGENTS_COPY,
  KIN_OTHER_PROVIDER_AGENTS,
  kinDomainLabel,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { KinLeadProfile, ModelSelection } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Switch } from "../components/ui/switch";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { useOpenKinAgentPage } from "./kinAgentPageLink";
import { KinAgentModelPicker } from "./KinAgentModelPicker";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import { KinLoadFailed, KinWorkRowSkeletons } from "./KinWorkParts";
import type { KinWorkTarget } from "./useKinWork";

/** The company's agents and the model new ones start on, for the owner and co-owners. */
export function KinAgentsSetting() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <OwnerLevelAgents {...target} />;
}

function OwnerLevelAgents(props: KinWorkTarget) {
  const searchableSetting = useSearchableSetting();
  if (!useKinOwnerLevel(props.environmentId)) return null;
  return (
    <SettingsSection {...searchableSetting("kin-agents")}>
      <CompanyDefault {...props} />
      <OpenAiAgents {...props} />
      <AgentRows {...props} />
    </SettingsSection>
  );
}

/** The model new agents start on; the owner and co-owners change it. */
export function KinAgentDefaultsSetting(props: KinWorkTarget) {
  const searchableSetting = useSearchableSetting();
  if (!useKinOwnerLevel(props.environmentId)) return null;
  return (
    <SettingsSection {...searchableSetting("kin-agents")}>
      <CompanyDefault {...props} />
      <OpenAiAgents {...props} />
    </SettingsSection>
  );
}

/** The host's experimental switch that lets agents run on Codex models too. */
function OpenAiAgents(props: KinWorkTarget) {
  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  return (
    <SettingsRow
      title={KIN_OTHER_PROVIDER_AGENTS.title}
      description={KIN_OTHER_PROVIDER_AGENTS.detail}
      control={
        <Switch
          checked={settings.kinNonClaudeAgents}
          onCheckedChange={(checked) =>
            void updateSettings({ kinNonClaudeAgents: Boolean(checked) })
          }
          aria-label={KIN_OTHER_PROVIDER_AGENTS.title}
        />
      }
    />
  );
}

function CompanyDefault(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const defaultsAtom = kinClient.agentDefaults({ environmentId, input: { orgId } });
  const defaults = Option.getOrNull(AsyncResult.value(useAtomValue(defaultsAtom)));
  const save = useAtomCommand(kinClient.agentDefaultsSet, { reportFailure: false });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = defaults?.model ?? null;

  const choose = async (model: ModelSelection) => {
    setBusy(true);
    const outcome = await save({ environmentId, input: { orgId, model } });
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
          `${KIN_AGENT_PAGE.defaultsDetail}${defaults?.chosen === false ? ` ${KIN_AGENT_PAGE.defaultsUnchosen}` : ""}`
        ) : (
          <span role="alert">{problem}</span>
        )
      }
      control={
        base === null ? undefined : (
          <div className="max-w-xs">
            <KinAgentModelPicker
              environmentId={environmentId}
              label={KIN_AGENT_PAGE.defaults}
              selection={base}
              disabled={busy}
              onChange={(selection) => void choose(selection)}
            />
          </div>
        )
      }
    />
  );
}

function AgentRows(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const openPage = useOpenKinAgentPage();
  const atom = kinClient.agents(props);
  const result = useAtomValue(atom);
  const leads = Option.getOrNull(AsyncResult.value(result));
  if (leads === null)
    return AsyncResult.isFailure(result) ? (
      <KinLoadFailed
        what={KIN_AGENTS_COPY.loadFailedTitle}
        cause={result}
        onRetry={() => appAtomRegistry.refresh(atom)}
        className="px-4 py-3"
      />
    ) : (
      <div role="status" aria-label="Loading agents">
        <KinWorkRowSkeletons />
      </div>
    );
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
