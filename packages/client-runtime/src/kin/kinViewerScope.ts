import { kinOwnerLevel, type KinAccessMeResult } from "@t3tools/contracts";

/**
 * What part of the company a viewer is looking at. The owner and co-owners see everything, so an
 * empty place means nothing is there. Anyone else sees what is shared with them, so an empty place
 * only means nothing they can see, and the words have to say so.
 */
export interface KinViewerScope {
  readonly all: boolean;
  /** Titles of the projects they lead, where they see more than the team does. */
  readonly leads: ReadonlyArray<string>;
}

export const KIN_SCOPE_ALL: KinViewerScope = { all: true, leads: [] };

/** Until the host says who the viewer is, words stay as for a teammate: never overclaim. */
export function kinViewerScope(
  me: Pick<KinAccessMeResult, "access" | "leads"> | null | undefined,
): KinViewerScope {
  if (me != null && kinOwnerLevel(me.access)) return KIN_SCOPE_ALL;
  return { all: false, leads: (me?.leads ?? []).map((lead) => lead.title) };
}

const listed = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const WHO_SHARES = "The owner or a co-owner shares";

export type KinScopedPlace = "money" | "clients" | "projects" | "docs" | "tasks" | "search";

/** One line under a place's title saying what a teammate is looking at; null for the owner level. */
export function kinScopeNote(place: KinScopedPlace, scope: KinViewerScope): string | null {
  if (scope.all) return null;
  const led = scope.leads.length === 0 ? null : listed(scope.leads);
  switch (place) {
    case "money":
      return led === null
        ? "Only figures shared with the team."
        : `Only figures shared with the team, and money filed under ${led}.`;
    case "clients":
    case "projects":
      return "Only what you can see. Private clients don't show here.";
    case "docs":
      return "Company docs and your projects' docs. Private ones don't show here.";
    case "tasks":
      return "Your tasks, your projects' and the team's.";
    case "search":
      return "Search finds only what you can see.";
  }
}

/**
 * What an empty place says to someone who sees only part of it: "nothing you can see", and who
 * can change that. Null for the owner level, whose place's own words ("No clients yet") are true.
 */
export function kinNothingShown(
  place: KinScopedPlace,
  scope: KinViewerScope,
): { readonly title: string; readonly detail: string } | null {
  if (scope.all) return null;
  const led = scope.leads.length === 0 ? null : listed(scope.leads);
  switch (place) {
    case "money":
      return {
        title: "Nothing shared with you",
        detail:
          led === null
            ? `${WHO_SHARES} invoices, payments and expenses with the team. None are shared yet.`
            : `${WHO_SHARES} figures with the team, and money filed under ${led} shows here. There is none yet.`,
      };
    case "clients":
      return {
        title: "No clients you can see",
        detail:
          "Clients show here when you work on one of their projects, or when they're not private.",
      };
    case "projects":
      return {
        title: "No projects you can see",
        detail: "Projects you're on, and the team's, show here.",
      };
    case "docs":
      return {
        title: "No docs you can see",
        detail: "Company docs and your projects' docs show here. Private ones stay with the owner.",
      };
    case "tasks":
      return {
        title: "Nothing you can see",
        detail: "Tasks you hold, made or gave, your projects' and the team's show here.",
      };
    case "search":
      return {
        title: "Nothing you can see matches",
        detail: "Search finds only what you can see. Try other words.",
      };
  }
}

/** "Nobody owes you anything right now" is a fact only for the owner level. */
export function kinNothingOwed(scope: KinViewerScope): string {
  return scope.all
    ? "Nobody owes you anything right now."
    : "Nothing owed is shared with you. The owner or a co-owner decides what the team sees.";
}
