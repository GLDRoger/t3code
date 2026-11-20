import type { KinSettingsPage } from "@t3tools/client-runtime/kin/kinNavigation";

import { KIN_APPROVER_PHONES_TITLE } from "@t3tools/client-runtime/kin/kinApprovalPresentation";
import { msg } from "gt-react";

import type {
  SettingsSearchItem,
  SettingsSearchScope,
} from "../components/settings/settingsSearch";

/** Kin's own pages in the app's Settings; while a host runs Kin, each opens Kin's Settings. */
export type KinSettingsPath =
  | "/settings/approvals"
  | "/settings/company"
  | "/settings/check-ins"
  | "/settings/deals"
  | "/settings/kin-connections"
  | "/settings/kin-profile";

export const KIN_SETTINGS_SECTION_LABELS: Readonly<Record<KinSettingsPath, string>> = {
  "/settings/approvals": msg("Approvals"),
  "/settings/company": msg("Company details"),
  "/settings/check-ins": msg("Check-ins"),
  "/settings/deals": msg("Deals"),
  "/settings/kin-connections": msg("Connections"),
  "/settings/kin-profile": msg("Profile"),
};

export const KIN_SETTINGS_CATEGORY_SCOPES: Readonly<
  Record<KinSettingsPath, SettingsSearchScope | null>
> = {
  "/settings/approvals": null,
  "/settings/company": null,
  "/settings/check-ins": null,
  "/settings/deals": null,
  "/settings/kin-connections": null,
  "/settings/kin-profile": null,
};

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
  {
    id: "kin-github-username",
    title: "GitHub username",
    to: "/settings/kin-profile",
    searchTerms: ["kin github username login pull requests review"],
    kinOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

/** Kin's settings as the app's settings search finds them. */
export const KIN_SETTINGS_SEARCH_ITEMS = [
  {
    id: "approval-phones",
    kinOnly: true,
    title: KIN_APPROVER_PHONES_TITLE,
    to: "/settings/approvals",
    searchTerms: [
      "kin approvals approve phone face id set up remove key device lost new recent changes",
    ],
  },
  {
    id: "company-details",
    kinOnly: true,
    title: "Company details",
    to: "/settings/company",
    searchTerms: ["kin legal name address gstin pan tax bank account ifsc upi invoice"],
  },
  {
    id: "kin-connections",
    kinOnly: true,
    title: "Connections",
    to: "/settings/kin-connections",
    searchTerms: ["kin connected services tools posthog github key agents read"],
  },
  {
    id: "kin-time-zone",
    kinOnly: true,
    title: "Time zone",
    to: "/settings/company",
    searchTerms: ["kin timezone zone check-ins due dates hours clock"],
  },
  {
    id: "kin-agents",
    kinOnly: true,
    title: "Agents",
    to: "/settings/company",
    searchTerms: ["kin agents model character personality pause retire new agents default"],
  },
  {
    id: "kin-who-can-message",
    kinOnly: true,
    title: "Who can message",
    to: "/settings/company",
    searchTerms: [
      "kin restrict restricted restriction message messaging who can message lift block",
    ],
  },
  {
    id: "kin-daily-limit",
    kinOnly: true,
    title: "Daily limit",
    to: "/settings/company",
    searchTerms: ["kin budget agents usage spend limit"],
  },
  {
    id: "kin-check-ins",
    kinOnly: true,
    title: "Check-ins",
    to: "/settings/check-ins",
    searchTerms: ["kin schedule morning afternoon weekly brief routine time run now"],
  },
  ...KIN_PROFILE_SETTINGS_SEARCH_ITEMS,
  {
    id: "kin-deals",
    kinOnly: true,
    title: "Deal stages",
    to: "/settings/deals",
    searchTerms: ["kin deals stages pipeline won lost sales prospect"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

// A found Kin setting that Kin's Settings keeps on another page than its app address names.
const KIN_SETTING_ELSEWHERE: Readonly<Record<string, KinSettingsPage>> = {
  "kin-agents": "agents",
  "kin-who-can-message": "team",
};

/** The page of Kin's Settings that holds the setting `target`, reached from an address for `page`. */
export const kinSettingsPageHolding = (page: KinSettingsPage, target: string): KinSettingsPage =>
  KIN_SETTING_ELSEWHERE[target] ?? page;
