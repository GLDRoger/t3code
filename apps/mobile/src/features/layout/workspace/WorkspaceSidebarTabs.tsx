export function WorkspaceSidebarTabs(_props: {
  readonly onNewTask?: () => void;
  readonly compact?: boolean;
  readonly reserveComposeSpace?: boolean;
}) {
  return null;
}

export function SidebarTabBar<Tab extends string>(_props: {
  readonly tabs: ReadonlyArray<Tab>;
  readonly selectedTab: string;
  readonly onSelect: (tab: Tab) => void;
  /** The native bar's name for a tab, where it differs; it draws the icon and label for each name. */
  readonly nativeTab?: (tab: Tab) => string;
  readonly onNewTask?: () => void;
  readonly compact?: boolean;
  readonly reserveComposeSpace?: boolean;
}) {
  return null;
}
