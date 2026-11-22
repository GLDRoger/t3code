import { useAtomValue } from "@effect/atom-react";
import { KIN_AGENT_PAGE, kinAgentModelLine } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_AGENTS_COPY,
  KIN_AGENTS_PAGE,
  KIN_OTHER_PROVIDER_AGENTS,
  kinLeadModelName,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ModelSelection } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Switch } from "../components/ui/switch";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAgentModelPicker, useKinAgentModels } from "./KinAgentModelPicker";
import { kinClient } from "./kinClient";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { KinSettingsField, KinSettingsFormDialog } from "./settings/KinSettingsControls";
import { KinSettingsRow, KinSettingsSection } from "./settings/KinSettingsLayout";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import type { KinWorkTarget } from "./useKinWork";

/** The old Company settings address's agents block, before Kin's Settings take it over. */
export function KinAgentsSetting() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <KinAgentDefaultsSections {...target} />;
}

/**
 * Settings → Agents, below the list: what new agents start on, then the experiment that lets
 * agents run on other providers. The owner and co-owners only.
 */
export function KinAgentDefaultsSections(props: KinWorkTarget) {
  if (!useKinOwnerLevel(props.environmentId)) return null;
  return (
    <>
      <CompanyDefault {...props} />
      <OpenAiAgents {...props} />
    </>
  );
}

/** The host's experimental switch that lets agents run on Codex models too; it saves on flip. */
function OpenAiAgents(props: KinWorkTarget) {
  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  return (
    <KinSettingsSection title={KIN_OTHER_PROVIDER_AGENTS.section}>
      <KinSettingsRow
        title={KIN_OTHER_PROVIDER_AGENTS.row}
        wrap
        detail={KIN_OTHER_PROVIDER_AGENTS.rowDetail}
        control={
          <Switch
            checked={settings.kinNonClaudeAgents}
            onCheckedChange={(checked) =>
              void updateSettings({ kinNonClaudeAgents: Boolean(checked) })
            }
            aria-label={KIN_OTHER_PROVIDER_AGENTS.row}
          />
        }
      />
    </KinSettingsSection>
  );
}

/** The model and effort new agents start on: a row saying it, opening a form to change both. */
function CompanyDefault(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const searchableSetting = useSearchableSetting();
  const defaultsAtom = kinClient.agentDefaults({ environmentId, input: { orgId } });
  const defaults = Option.getOrNull(AsyncResult.value(useAtomValue(defaultsAtom)));
  const { providers } = useKinAgentModels(environmentId);
  const [editing, setEditing] = useState(false);
  const base = defaults?.model ?? null;
  const line =
    base === null ? null : kinAgentModelLine(kinLeadModelName(base.model, providers), base);
  return (
    <KinSettingsSection
      title={KIN_AGENTS_PAGE.forNew}
      searchId={searchableSetting("kin-agents").id}
    >
      <KinSettingsRow
        title={KIN_AGENTS_PAGE.model}
        detail={
          line === null
            ? undefined
            : defaults?.chosen === false
              ? KIN_AGENTS_PAGE.unchosen(line)
              : line
        }
        openLabel={KIN_AGENTS_PAGE.defaultsTitle}
        {...(base === null ? {} : { onOpen: () => setEditing(true) })}
      />
      {editing && base !== null ? (
        <DefaultsDialog
          {...props}
          base={base}
          unchosen={defaults?.chosen === false}
          onSaved={() => appAtomRegistry.refresh(defaultsAtom)}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </KinSettingsSection>
  );
}

function DefaultsDialog(
  props: KinWorkTarget & {
    readonly base: ModelSelection;
    readonly unchosen: boolean;
    readonly onSaved: () => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId } = props;
  const save = useAtomCommand(kinClient.agentDefaultsSet, { reportFailure: false });
  const [model, setModel] = useState(props.base);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await save({ environmentId, input: { orgId, model } });
    setBusy(false);
    props.onSaved();
    if (AsyncResult.isSuccess(outcome)) props.onClose();
    else setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENTS_COPY.saveFailed));
  };
  return (
    <KinSettingsFormDialog
      title={KIN_AGENTS_PAGE.defaultsTitle}
      description={
        props.unchosen
          ? `${KIN_AGENT_PAGE.defaultsDetail} ${KIN_AGENT_PAGE.defaultsUnchosen}`
          : KIN_AGENT_PAGE.defaultsDetail
      }
      submitLabel={KIN_AGENTS_PAGE.save}
      busy={busy}
      problem={problem}
      onSubmit={() => void submit()}
      onClose={props.onClose}
    >
      <KinSettingsField label={KIN_AGENTS_PAGE.defaultsLabel}>
        {() => (
          <KinAgentModelPicker
            environmentId={environmentId}
            label={KIN_AGENTS_PAGE.defaultsLabel}
            selection={model}
            disabled={busy}
            onChange={setModel}
          />
        )}
      </KinSettingsField>
    </KinSettingsFormDialog>
  );
}
