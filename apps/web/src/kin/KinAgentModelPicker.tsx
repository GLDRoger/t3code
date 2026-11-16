import { useAtomValue } from "@effect/atom-react";
import { KIN_AGENT_DRIVER } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { providerInstanceEntriesFor } from "../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";

/** The Claude models this server really offers: agents run on nothing else. */
export function useKinAgentModels(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null).filter(
    (entry) => entry.driverKind === KIN_AGENT_DRIVER && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const offered = instanceEntries.flatMap((entry) =>
    (modelOptionsByInstance.get(entry.instanceId) ?? []).map((model): ModelSelection => ({
      instanceId: entry.instanceId,
      model: model.slug,
    })),
  );
  return { providers, instanceEntries, modelOptionsByInstance, offered };
}

/** T3's own model picker and effort control, limited to the Claude models agents can run on. */
export function KinAgentModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly selection: ModelSelection;
  readonly disabled?: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { instanceEntries, modelOptionsByInstance } = useKinAgentModels(props.environmentId);
  const { selection } = props;
  const entry = instanceEntries.find((one) => one.instanceId === selection.instanceId);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ProviderModelPicker
        environmentId={props.environmentId}
        disabled={props.disabled === true}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        isComposerOwned={false}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        triggerAriaLabel={props.label}
        onInstanceModelChange={(instanceId, model) =>
          props.onChange(createModelSelection(instanceId, model))
        }
      />
      {entry === undefined ? null : (
        <TraitsPicker
          provider={entry.driverKind}
          models={entry.models}
          model={selection.model}
          modelOptions={selection.options ?? []}
          allowPromptInjectedEffort={false}
          disabled={props.disabled === true}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onModelOptionsChange={(options) =>
            props.onChange(createModelSelection(selection.instanceId, selection.model, options))
          }
        />
      )}
    </div>
  );
}
