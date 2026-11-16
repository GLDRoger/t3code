import type { KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";
import { View } from "react-native";

import { SidebarTabBar } from "../../layout/workspace/WorkspaceSidebarTabs";
import { useFloatingWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { workspaceDockBottomClearance } from "../../layout/workspace/workspace-tabs-state";
import type { KinDockProps } from "./KinDock";

/** The native dock's names for the Kin tabs; it draws the icon and label for each. */
const KIN_DOCK_NAMES: Record<KinDockTab, string> = {
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
        tabs={props.tabs}
        selectedTab={props.selectedTab}
        onSelect={props.onSelect}
        nativeTab={(tab) => KIN_DOCK_NAMES[tab]}
      />
    </View>
  );
}

export function kinDockClearance(bottomInset: number) {
  return workspaceDockBottomClearance({ bottomInset, keyboardHeight: 0 });
}
