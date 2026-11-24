import type { KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";

import { AndroidTabBar } from "../../layout/workspace/AndroidWorkspaceNavigation";
import type { KinDockProps } from "./KinDock";

// The native bar draws Chats under the workspace's id for it; any id it doesn't know reads "Settings".
const nativeTab = (tab: KinDockTab) => (tab === "chats" ? "threads" : tab);

/** The workspace's bottom navigation bar, under the tab rather than over it. */
export function KinDock(props: KinDockProps) {
  return (
    <AndroidTabBar
      tabs={props.tabs.map(nativeTab)}
      selectedTab={nativeTab(props.selectedTab)}
      onSelect={(tab) => props.onSelect(tab === "threads" ? "chats" : tab)}
      {...(props.titles === undefined ? {} : { titles: props.titles })}
    />
  );
}

/** The bar takes its own room, so a tab needs none under its last row. */
export function kinDockClearance(_bottomInset: number) {
  return 0;
}
