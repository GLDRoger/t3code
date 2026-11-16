import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import {
  kinAgentDriverAllowed,
  kinLeadModelName,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";

/** The models this server offers that agents may run on, as T3's own model menu lists them. */
export function useKinAgentModelOptions(environmentId: EnvironmentId): ReadonlyArray<ModelOption> {
  const config = useEnvironmentServerConfig(environmentId);
  return buildModelOptions(config, null, undefined, null).filter(
    (option) =>
      kinAgentDriverAllowed(option.providerDriver, config?.settings.kinNonClaudeAgents === true) &&
      !option.isUnavailable &&
      !option.isHidden,
  );
}

/** One of an agent's models: a row that opens the server's agent models as a menu. */
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
  // With more than one provider or account listed, each name says which.
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
