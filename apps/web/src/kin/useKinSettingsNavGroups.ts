import type { settingsNavGroups } from "../components/settings/settingsSearch";
import { kinListShownAt } from "./kinListSwitch";
import { KIN_CODING_SETTINGS } from "./kinNoCode";
import { KIN_WEB_ONLY } from "./kinWebOnly";
import { useKinHost } from "./useKinHost";

type SettingsNavGroups = ReturnType<typeof settingsNavGroups>;

/**
 * The app's Settings groups; over Kin, its check-ins are the schedule, so scheduled tasks go, and
 * the Kin web app has no coding pages at all.
 */
export function useKinSettingsNavGroups(groups: SettingsNavGroups, pathname: string) {
  const overKin = useKinHost()._tag === "host" && kinListShownAt(pathname) === "kin";
  return kinSettingsNavGroups(groups, { overKin, kinOnly: KIN_WEB_ONLY });
}

export function kinSettingsNavGroups(
  groups: SettingsNavGroups,
  { overKin, kinOnly }: { readonly overKin: boolean; readonly kinOnly: boolean },
): SettingsNavGroups {
  if (!overKin && !kinOnly) return groups;
  const hidden = (path: string) =>
    (kinOnly && KIN_CODING_SETTINGS.has(path)) || path === "/settings/scheduled-tasks";
  return groups
    .map((group) => ({ ...group, paths: group.paths.filter((path) => !hidden(path)) }))
    .filter((group) => group.paths.length > 0);
}
