import type { SETTINGS_NAV_GROUPS } from "../components/settings/settingsSearch";
import { kinListShownAt } from "./kinListSwitch";
import { KIN_CODING_SETTINGS } from "./kinNoCode";
import { KIN_WEB_ONLY } from "./kinWebOnly";
import { useKinHost } from "./useKinHost";

/**
 * The app's Settings groups; over Kin, its check-ins are the schedule, so scheduled tasks go, and
 * the Kin web app has no coding pages at all.
 */
export function useKinSettingsNavGroups(groups: typeof SETTINGS_NAV_GROUPS, pathname: string) {
  const overKin = useKinHost()._tag === "host" && kinListShownAt(pathname) === "kin";
  return kinSettingsNavGroups(groups, { overKin, kinOnly: KIN_WEB_ONLY });
}

export function kinSettingsNavGroups(
  groups: typeof SETTINGS_NAV_GROUPS,
  { overKin, kinOnly }: { readonly overKin: boolean; readonly kinOnly: boolean },
): typeof SETTINGS_NAV_GROUPS {
  if (!overKin && !kinOnly) return groups;
  const hidden = (path: string) =>
    (kinOnly && KIN_CODING_SETTINGS.has(path)) || path === "/settings/scheduled-tasks";
  return groups
    .map((group) => ({ ...group, paths: group.paths.filter((path) => !hidden(path)) }))
    .filter((group) => group.paths.length > 0);
}
