import type { KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";

export interface KinDockProps {
  readonly tabs: ReadonlyArray<KinDockTab>;
  readonly selectedTab: KinDockTab;
  readonly onSelect: (tab: KinDockTab) => void;
  /** A short count on a tab: unread on Chats, what needs attention on Tasks. iOS only for now. */
  readonly badges?: Partial<Readonly<Record<KinDockTab, string>>>;
  /** A list section's tab is called by the list's own name; Kin's places name themselves. */
  readonly titles?: Readonly<Record<string, string>>;
}

/** The Kin home's dock; each platform draws the native bar its workspace uses. */
export function KinDock(_props: KinDockProps) {
  return null;
}

/** Room a tab leaves under its last row for the dock. */
export function kinDockClearance(_bottomInset: number) {
  return 0;
}
