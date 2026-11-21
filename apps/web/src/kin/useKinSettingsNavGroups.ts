import type { SETTINGS_NAV_GROUPS } from "../components/settings/settingsSearch";
import { kinListShownAt } from "./kinListSwitch";
import { useKinHost } from "./useKinHost";

/** The app's Settings groups; over Kin, its check-ins are the schedule, so scheduled tasks go. */
export function useKinSettingsNavGroups(groups: typeof SETTINGS_NAV_GROUPS, pathname: string) {
  const overKin = useKinHost()._tag === "host" && kinListShownAt(pathname) === "kin";
  if (!overKin) return groups;
  return groups.map((group) => ({
    ...group,
    paths: group.paths.filter((path) => path !== "/settings/scheduled-tasks"),
  }));
}
