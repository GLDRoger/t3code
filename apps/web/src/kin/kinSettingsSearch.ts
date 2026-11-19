import type { SettingsSearchItem } from "../components/settings/settingsSearch";

/**
 * Kin's own Profile settings, found from the app's settings search; the address opens Kin's
 * Settings on Profile at the one found. Devices are left out: the owner's are the app's own
 * pairings, and a teammate's session has no app settings to search.
 */
export const KIN_PROFILE_SETTINGS_SEARCH_ITEMS = [
  {
    id: "kin-quiet-hours",
    title: "Quiet hours",
    to: "/settings/kin-profile",
    searchTerms: ["kin quiet hold night silence notifications do not disturb sleep"],
    kinOnly: true,
  },
  {
    id: "kin-working-hours",
    title: "Working hours",
    to: "/settings/kin-profile",
    searchTerms: ["kin hours work day schedule available time zone"],
    kinOnly: true,
  },
  {
    id: "kin-away",
    title: "Away",
    to: "/settings/kin-profile",
    searchTerms: ["kin away holiday leave vacation out of office back"],
    kinOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
