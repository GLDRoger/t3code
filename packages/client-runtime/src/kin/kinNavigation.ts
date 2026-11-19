/**
 * Kin's navigation, one model for web and phone: the five destinations, and what Settings (the
 * gear on Chats) holds for each person.
 */

export type KinDestination = "chats" | "tasks" | "money" | "clients" | "docs";

export const KIN_DESTINATION_NAMES: Readonly<Record<KinDestination, string>> = {
  chats: "Chats",
  tasks: "Tasks",
  money: "Money",
  clients: "Clients",
  docs: "Docs",
};

/** Places the host has answered it won't show this viewer, which a grant can't tell apart. */
export interface KinPlacesRefused {
  readonly money: boolean;
  readonly clients: boolean;
  readonly docs: boolean;
}

/**
 * Chats, then Tasks when the viewer may read Work, then each place the host hasn't refused: every
 * one for the owner or a co-owner, for anyone else the ones the host says they reach, none until
 * it has. A destination the viewer can't open is absent, never disabled.
 */
export function kinDestinations(input: {
  readonly work: boolean;
  readonly ownerLevel: boolean;
  readonly refused: KinPlacesRefused;
  readonly reaches: KinPlacesRefused | null;
}): ReadonlyArray<KinDestination> {
  if (!input.work) return ["chats"];
  const shown = (place: keyof KinPlacesRefused) =>
    !input.refused[place] && (input.ownerLevel || input.reaches?.[place] === true);
  return [
    "chats",
    "tasks",
    ...(shown("money") ? (["money"] as const) : []),
    ...(shown("clients") ? (["clients"] as const) : []),
    ...(shown("docs") ? (["docs"] as const) : []),
  ];
}

/**
 * The dock to draw: the live one once the host has said who this is; until then the one this device
 * last drew, so a cold start offline keeps its places; Chats alone with neither. Each place still
 * reads live and says offline or loading, never refused, until the host answers.
 */
export function kinDockShown(input: {
  readonly live: ReadonlyArray<KinDestination> | null;
  readonly cached: ReadonlyArray<KinDestination> | null;
}): { readonly tabs: ReadonlyArray<KinDestination>; readonly known: boolean } {
  return { tabs: input.live ?? input.cached ?? ["chats"], known: input.live !== null };
}

/**
 * The tab to show for the one the person is in. Only the host taking that place away moves them
 * (`leave`: to Chats, for good); a place not known yet shows Chats meanwhile and comes back, and a
 * place appearing never opens itself.
 */
export function kinDockSelection(input: {
  readonly held: KinDestination;
  readonly tabs: ReadonlyArray<KinDestination>;
  readonly known: boolean;
}): { readonly shown: KinDestination; readonly leave: boolean } {
  if (input.tabs.includes(input.held)) return { shown: input.held, leave: false };
  return { shown: "chats", leave: input.known };
}

/**
 * The web's rule for the place in its address, where the phone has `kinDockSelection`: it never
 * navigates. The page follows the host both ways where it is: its content while the place is this
 * person's, its refusal once the host has said it isn't, its own loading until the host has said.
 */
export function kinPlaceInPlace(input: {
  readonly held: KinDestination;
  readonly tabs: ReadonlyArray<KinDestination>;
  readonly known: boolean;
}): "shown" | "refused" | "pending" {
  if (input.tabs.includes(input.held)) return "shown";
  return input.known ? "refused" : "pending";
}

export type KinSettingsPage =
  | "profile"
  | "notifications"
  | "appearance"
  | "team"
  | "agents"
  | "check-ins"
  | "connections"
  | "memory"
  | "company"
  | "approvals"
  | "recommendations";

const KIN_SETTINGS_PAGES: ReadonlyArray<KinSettingsPage> = [
  "profile",
  "notifications",
  "appearance",
  "team",
  "agents",
  "check-ins",
  "connections",
  "memory",
  "company",
  "approvals",
  "recommendations",
];

export const KIN_SETTINGS_PAGE_TITLES: Readonly<Record<KinSettingsPage, string>> = {
  profile: "Profile",
  notifications: "Notifications",
  appearance: "Appearance",
  team: "Team",
  agents: "Agents",
  "check-ins": "Check-ins",
  connections: "Connections",
  memory: "Memory",
  company: "Company details",
  approvals: "Approvals",
  recommendations: "Recommendations",
};

export type KinSettingsGroupId = "you" | "company" | "computer";

const KIN_SETTINGS_GROUP_TITLES: Readonly<Record<KinSettingsGroupId, string>> = {
  you: "You",
  company: "Company",
  computer: "This computer",
};

export interface KinSettingsGroup {
  readonly id: KinSettingsGroupId;
  readonly title: string;
  /** Kin's own pages. This computer has none: its rows are the app's own settings. */
  readonly pages: ReadonlyArray<KinSettingsPage>;
}

/**
 * What Settings holds for this person. Everyone has You; the owner and co-owners add Company; This
 * computer (the app's own settings) shows only where the session can open them. `notifications`
 * says whether this surface has Kin notifications to set; `recommendations` whether this is the
 * owner, who alone sees what Kin suggested.
 */
export function kinSettingsGroups(input: {
  readonly ownerLevel: boolean;
  readonly computer: boolean;
  readonly notifications: boolean;
  readonly recommendations: boolean;
}): ReadonlyArray<KinSettingsGroup> {
  const you: KinSettingsGroup = {
    id: "you",
    title: KIN_SETTINGS_GROUP_TITLES.you,
    pages: ["profile", ...(input.notifications ? (["notifications"] as const) : []), "appearance"],
  };
  if (!input.ownerLevel) return [you];
  return [
    you,
    {
      id: "company",
      title: KIN_SETTINGS_GROUP_TITLES.company,
      pages: [
        "team",
        "agents",
        "check-ins",
        "connections",
        "memory",
        "company",
        "approvals",
        ...(input.recommendations ? (["recommendations"] as const) : []),
      ],
    },
    ...(input.computer
      ? [{ id: "computer" as const, title: KIN_SETTINGS_GROUP_TITLES.computer, pages: [] }]
      : []),
  ];
}

/** A Settings address this person may open; anything else lands on their profile. */
export function kinSettingsPageOf(
  raw: string | undefined,
  groups: ReadonlyArray<KinSettingsGroup>,
): KinSettingsPage {
  const page = KIN_SETTINGS_PAGES.find((one) => one === raw);
  return page !== undefined && groups.some((group) => group.pages.includes(page))
    ? page
    : "profile";
}

/** Where an old app Settings address for a Kin page now lives in Kin's Settings. */
export const KIN_SETTINGS_MOVED: Readonly<Record<string, KinSettingsPage>> = {
  company: "company",
  "check-ins": "check-ins",
  "kin-connections": "connections",
  approvals: "approvals",
};
