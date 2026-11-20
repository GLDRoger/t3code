import type { KinSettingsPage } from "@t3tools/client-runtime/kin/kinNavigation";

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

// A found Kin setting that Kin's Settings keeps on another page than its app address names.
const KIN_SETTING_ELSEWHERE: Readonly<Record<string, KinSettingsPage>> = {
  "kin-agents": "agents",
};

/** The page of Kin's Settings that holds the setting `target`, reached from an address for `page`. */
export const kinSettingsPageHolding = (page: KinSettingsPage, target: string): KinSettingsPage =>
  KIN_SETTING_ELSEWHERE[target] ?? page;
