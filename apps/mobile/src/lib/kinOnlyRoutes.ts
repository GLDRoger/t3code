import type { NavigationState, PartialState } from "@react-navigation/native";

/**
 * The root routes a Kin-only app keeps besides Kin's own screens: Home, pairing, and the settings
 * that are about this app. Everything else is a coding screen, which that build never registers,
 * so a route added upstream stays out until it is listed here.
 */
export const KIN_ONLY_SHARED_ROUTES = [
  "Home",
  "Settings",
  "SettingsAppearance",
  "SettingsAbout",
  "SettingsClientStorage",
  "SettingsDiagnostics",
  "SettingsOpenSourceLicenses",
  "SettingsOpenSourceLicense",
  "SettingsLegal",
  "SettingsScheduledTasks",
  "SettingsScheduledTaskEdit",
  "SettingsScheduledTaskBranch",
  "SettingsScheduledTaskThread",
  "SettingsScheduledTaskModel",
  "SettingsEnvironmentNew",
  "ConnectionsNew",
  // A document attached in a Kin chat opens in the shared file viewer.
  "ThreadAttachment",
  "ComponentCatalog",
] as const;

/** Kin's own routes a Kin-only app leaves out: there Home is the chat list. */
const KIN_ONLY_DROPPED_KIN_ROUTES = new Set(["KinChats"]);

export function kinOnlyRouteNames(kinRoutes: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set([
    ...KIN_ONLY_SHARED_ROUTES,
    ...kinRoutes.filter((name) => !KIN_ONLY_DROPPED_KIN_ROUTES.has(name)),
  ]);
}

/** The screens a build registers: all of them, or only `allowed` when it is Kin-only. */
export function kinOnlyScreens<Screens extends Readonly<Record<string, unknown>>>(
  screens: Screens,
  allowed: ReadonlySet<string> | null,
): Screens {
  if (allowed === null) return screens;
  // The navigator's types still name every route; a Kin-only build only ever opens the kept ones.
  return Object.fromEntries(
    Object.entries(screens).filter(([name]) => allowed.has(name)),
  ) as Screens;
}

type LinkState = PartialState<NavigationState>;

/**
 * Where a link opens in a Kin-only app. A link to a coding screen (a thread, a pull request,
 * usage, a setting this app doesn't have) or to nothing at all opens Home, which is the chat list.
 */
export function kinOnlyLinkState(
  state: LinkState | undefined,
  allowed: ReadonlySet<string>,
): LinkState {
  return state !== undefined &&
    state.routes.length > 0 &&
    state.routes.every((route) => allowed.has(route.name))
    ? state
    : { routes: [{ name: "Home" }] };
}

/**
 * Whether a link's state is Home alone. Navigating there would push a second Home over whatever
 * is open, so the app resets to it instead.
 */
export function isHomeLinkState(state: LinkState | undefined): boolean {
  return state?.routes.length === 1 && state.routes[0]?.name === "Home";
}

/**
 * The address a coding thread has in the web app of the computer this phone is paired with, or
 * null when that computer has no address a browser can open (a relay or tunnel connection).
 */
export function kinThreadWebUrl(
  hostAddress: string | null,
  thread: { readonly environmentId: string; readonly threadId: string },
): string | null {
  if (hostAddress === null || !URL.canParse(hostAddress)) return null;
  const base = new URL(hostAddress);
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  return new URL(
    `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
    base,
  ).toString();
}
