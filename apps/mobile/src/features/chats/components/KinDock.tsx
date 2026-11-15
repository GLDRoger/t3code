import type { KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";

export interface KinDockProps {
  readonly tabs: ReadonlyArray<KinDockTab>;
  readonly selectedTab: KinDockTab;
  readonly onSelect: (tab: KinDockTab) => void;
}

/** The Kin home's dock; each platform draws the native bar its workspace uses. */
export function KinDock(_props: KinDockProps) {
  return null;
}

/** Room a tab leaves under its last row for the dock. */
export function kinDockClearance(_bottomInset: number) {
  return 0;
}
