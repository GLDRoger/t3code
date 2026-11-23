import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { useControlTheme } from "../../../components/ui/useControlTheme";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";

const NativeSidebarTabBar = requireNativeView<
  ViewProps & {
    tabs: readonly string[];
    selectedTab: string;
    selectedColor: string;
    appearance: string;
    showsCompose: boolean;
    compact?: boolean;
    showsLabels?: boolean;
    badges?: Readonly<Record<string, string>>;
    titles?: Readonly<Record<string, string>>;
    onSelectionChange: (event: NativeSyntheticEvent<{ tab: string }>) => void;
    onCompose: () => void;
  }
>("T3NativeControls", "SidebarTabBar");

export function WorkspaceSidebarTabs(props: {
  readonly onNewTask?: () => void;
  readonly compact?: boolean;
  readonly reserveComposeSpace?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const { layout } = useAdaptiveWorkspaceLayout();
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const tabs = [...visibleNavigationTabs(order, hidden), "settings" as const];
  const selectTab = useSelectWorkspaceTab();
  return (
    <SidebarTabBar
      {...props}
      maxWidth={layout.variant === "medium" ? 280 : undefined}
      tabs={tabs}
      selectedTab={selectedNavigationTab(
        order,
        workspace.state.selectedTab,
        workspace.settingsOpen,
        hidden,
      )}
      onSelect={selectTab}
    />
  );
}

/** The native tab dock for any set of the tabs it can draw; the workspace and the Kin home share it. */
export function SidebarTabBar<Tab extends string>(props: {
  readonly tabs: ReadonlyArray<Tab>;
  readonly selectedTab: string;
  readonly onSelect: (tab: Tab) => void;
  /** The native bar's name for a tab, where it differs; it draws the icon and label for each name. */
  readonly nativeTab?: (tab: Tab) => string;
  readonly onNewTask?: () => void;
  readonly compact?: boolean;
  readonly reserveComposeSpace?: boolean;
  readonly maxWidth?: number | undefined;
  /** Titles under the icons; the workspace's own dock is icon-only. */
  readonly showsLabels?: boolean;
  /** A short count on a tab, keyed by tab. */
  readonly badges?: Partial<Readonly<Record<Tab, string>>>;
  /** Titles for tabs the bar doesn't name itself, keyed by native name; drawn with a list icon. */
  readonly titles?: Readonly<Record<string, string>>;
}) {
  const nativeTab = props.nativeTab ?? ((tab: Tab) => tab);
  const tabs = props.tabs.map(nativeTab);
  const selected = props.tabs.find((tab) => tab === props.selectedTab);
  const { colors, colorScheme } = useControlTheme();
  // UIKit loses accessible names when updating nil-titled items in place.
  const tabBarKey = `${tabs.join(":")}:${props.showsLabels ? "labels" : "icons"}:${Object.values(props.titles ?? {}).join(":")}`;
  return (
    <NativeSidebarTabBar
      key={tabBarKey}
      tabs={tabs}
      selectedTab={selected === undefined ? props.selectedTab : nativeTab(selected)}
      selectedColor={colors["--color-primary"]}
      appearance={colorScheme}
      showsCompose={Boolean(props.onNewTask)}
      compact={props.compact}
      showsLabels={props.showsLabels}
      titles={props.titles ?? {}}
      badges={Object.fromEntries(
        props.tabs.flatMap((tab) => {
          const badge = props.badges?.[tab];
          return badge === undefined ? [] : [[nativeTab(tab), badge]];
        }),
      )}
      onCompose={() => props.onNewTask?.()}
      onSelectionChange={({ nativeEvent }) => {
        const tab = props.tabs.find((candidate) => nativeTab(candidate) === nativeEvent.tab);
        if (tab) props.onSelect(tab);
      }}
      // Keep the host stable while UIKit updates the bars' intrinsic size and safe area together.
      style={{
        position: "absolute",
        bottom: 0,
        left: props.compact ? 8 : 0,
        maxWidth: props.maxWidth,
        // Keep the tab icons in place when Compose disappears on other destinations.
        right:
          (props.compact ? 12 : 0) +
          ((props.reserveComposeSpace ?? props.compact) && !props.onNewTask
            ? props.compact
              ? 64
              : 76
            : 0),
        height: 128,
      }}
    />
  );
}
