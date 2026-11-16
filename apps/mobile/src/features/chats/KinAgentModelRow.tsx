import { type EnvironmentId, isKinAgentDriver, type ModelSelection } from "@t3tools/contracts";
import {
  KIN_AGENT_EFFORT,
  kinAdviseEffort,
  kinEffortOffAdvice,
  kinWithMediumEffort,
} from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinLeadModelName } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { isReasoningSelect } from "@t3tools/client-runtime/model-traits";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";

/** The models this server offers agents, as T3's own model menu lists them. */
export function useKinAgentModelOptions(environmentId: EnvironmentId): ReadonlyArray<ModelOption> {
  const config = useEnvironmentServerConfig(environmentId);
  return buildModelOptions(config, null, undefined, null).filter(
    (option) =>
      isKinAgentDriver(option.providerDriver) && !option.isUnavailable && !option.isHidden,
  );
}

const modelsOn = (options: ReadonlyArray<ModelOption>, selection: ModelSelection) =>
  options
    .filter((option) => option.selection.instanceId === selection.instanceId)
    .map((option) => ({ slug: option.selection.model, capabilities: option.capabilities }));

/** A model picked on the phone, at Medium effort when it offers Medium. */
export const kinPickedModel = (options: ReadonlyArray<ModelOption>, selection: ModelSelection) =>
  kinWithMediumEffort(
    { instanceId: selection.instanceId, model: selection.model },
    modelsOn(options, selection),
  );

/** Kin's effort advice under the model rows, in the warning tone when the chosen effort is off it. */
export function KinAgentEffortAdvice(props: {
  readonly value: ModelSelection;
  readonly options: ReadonlyArray<ModelOption>;
}) {
  const off = kinEffortOffAdvice(props.value, modelsOn(props.options, props.value));
  return (
    <Text
      textRole="footnote"
      className={off ? "px-4 text-warning-foreground" : "px-4 text-foreground-muted"}
    >
      {KIN_AGENT_EFFORT.advice}
    </Text>
  );
}

/** The effort row of an agent's model: Medium and High first and marked. Null when it has none. */
export function KinAgentEffortRow(props: {
  readonly label: string;
  readonly value: ModelSelection;
  readonly options: ReadonlyArray<ModelOption>;
  readonly disabled: boolean;
  readonly onPick: (selection: ModelSelection) => void;
}) {
  const reasoning = props.options
    .find(
      (option) =>
        option.selection.instanceId === props.value.instanceId &&
        option.selection.model === props.value.model,
    )
    ?.capabilities?.optionDescriptors?.find(isReasoningSelect);
  const advised = reasoning === undefined ? undefined : kinAdviseEffort(reasoning);
  if (advised === undefined || !isReasoningSelect(advised)) return null;
  const chosenId = props.value.options?.find((option) => option.id === advised.id)?.value;
  const chosen =
    advised.options.find((option) => option.id === chosenId) ??
    advised.options.find((option) => option.isDefault === true);
  return (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${chosen?.label ?? ""}`}
      actions={advised.options.map((option) => ({
        id: option.id,
        title: option.label,
        ...(option.description === undefined ? {} : { subtitle: option.description }),
        state: option.id === chosen?.id ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) =>
        props.onPick({
          ...props.value,
          options: [
            ...(props.value.options ?? []).filter((option) => option.id !== advised.id),
            { id: advised.id, value: nativeEvent.event },
          ],
        })
      }
    >
      <Pressable
        disabled={props.disabled}
        className="flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
      >
        <Text className="min-w-0 flex-1 text-base text-foreground">{props.label}</Text>
        <Text className="shrink text-right text-base text-foreground-muted" numberOfLines={1}>
          {chosen?.label ?? ""}
        </Text>
        <SymbolView name="chevron.down" size={13} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </Menu>
  );
}

/** An agent's model: a row that opens the models the server offers agents as a menu. */
export function KinAgentModelRow(props: {
  readonly label: string;
  readonly value: ModelSelection;
  /** Its name when the menu doesn't list it, such as a model the server no longer offers. */
  readonly valueName?: string;
  readonly options: ReadonlyArray<ModelOption>;
  readonly disabled: boolean;
  readonly borderTop?: boolean;
  readonly onPick: (selection: ModelSelection) => void;
}) {
  const same = (option: ModelOption) =>
    option.selection.instanceId === props.value.instanceId &&
    option.selection.model === props.value.model;
  const current = props.options.find(same);
  // Two accounts list the same models; the account then tells them apart.
  const accounts = new Set(props.options.map((option) => option.providerKey)).size > 1;
  const name = (option: ModelOption) =>
    accounts ? `${option.label} · ${option.providerLabel}` : option.label;
  const shown =
    current === undefined
      ? (props.valueName ?? kinLeadModelName(props.value.model, null))
      : name(current);
  return (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${shown}`}
      actions={props.options.map((option) => ({
        id: option.key,
        title: name(option),
        state: same(option) ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const picked = props.options.find((option) => option.key === nativeEvent.event);
        if (picked !== undefined) props.onPick(picked.selection);
      }}
    >
      <Pressable
        disabled={props.disabled}
        className={
          props.borderTop
            ? "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            : "flex-row items-center gap-3 px-4 py-3"
        }
      >
        <Text className="min-w-0 flex-1 text-base text-foreground">{props.label}</Text>
        <Text className="shrink text-right text-base text-foreground-muted" numberOfLines={1}>
          {shown}
        </Text>
        <SymbolView name="chevron.down" size={13} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </Menu>
  );
}
