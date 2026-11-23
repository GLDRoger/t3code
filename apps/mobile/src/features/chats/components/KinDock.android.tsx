import { AndroidTabBar } from "../../layout/workspace/AndroidWorkspaceNavigation";
import type { KinDockProps } from "./KinDock";

/** The workspace's bottom navigation bar, under the tab rather than over it. */
export function KinDock(props: KinDockProps) {
  return (
    <AndroidTabBar
      tabs={props.tabs}
      selectedTab={props.selectedTab}
      onSelect={props.onSelect}
      {...(props.titles === undefined ? {} : { titles: props.titles })}
    />
  );
}

/** The bar takes its own room, so a tab needs none under its last row. */
export function kinDockClearance(_bottomInset: number) {
  return 0;
}
