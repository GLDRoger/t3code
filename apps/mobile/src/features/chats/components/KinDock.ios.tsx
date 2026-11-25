import type { KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";
import { kinIsListSection } from "@t3tools/client-runtime/kin/kinShell";
import { requireNativeView } from "expo";
import { View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import { useControlTheme } from "../../../components/ui/useControlTheme";
import { useFloatingWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { workspaceDockBottomClearance } from "../../layout/workspace/workspace-tabs-state";
import type { KinDockProps } from "./KinDock";

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

/** The native dock's names for the Kin tabs; it draws the icon and label for each. */
const KIN_DOCK_NAMES: Record<Exclude<KinDockTab, `list:${string}`>, string> = {
  chats: "threads",
  tasks: "tasks",
  money: "money",
  clients: "clients",
  docs: "docs",
};

/** The workspace's floating dock, over the foot of the tab. */
export function KinDock(props: KinDockProps) {
  const compact = useFloatingWorkspaceTabs();
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 128 }}
    >
      <SidebarTabBar
        compact={compact}
        reserveComposeSpace={false}
        showsLabels
        {...(props.badges === undefined ? {} : { badges: props.badges })}
        {...(props.titles === undefined ? {} : { titles: props.titles })}
        tabs={props.tabs}
        selectedTab={props.selectedTab}
        onSelect={props.onSelect}
        // A list section's tab keeps its id; the bar draws it with its title.
        nativeTab={(tab) => (kinIsListSection(tab) ? tab : KIN_DOCK_NAMES[tab])}
      />
    </View>
  );
}

export function kinDockClearance(bottomInset: number) {
  return workspaceDockBottomClearance({ bottomInset, keyboardHeight: 0 });
}

/** T3's native tab dock, drawing any set of the tabs it knows, with labels, badges and titles. */
function SidebarTabBar<Tab extends string>(props: {
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
