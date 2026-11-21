import { createWorkspaceStackNavigator as createPlatformStackNavigator } from "../features/layout/createWorkspaceStackNavigator";
import { KIN_SCREENS } from "../features/chats/routes";
import { KIN_ONLY } from "./kinOnly";
import { kinOnlyRouteNames, kinOnlyScreens } from "./kinOnlyRoutes";

/** The routes a Kin-only build registers; null in a build that also has the coding app. */
export const KIN_ONLY_ROUTES = KIN_ONLY ? kinOnlyRouteNames(Object.keys(KIN_SCREENS)) : null;

/** The workspace navigator, registering only Kin-only routes in that build. */
export const createWorkspaceStackNavigator: typeof createPlatformStackNavigator = (config) =>
  createPlatformStackNavigator(
    config?.screens === undefined
      ? config
      : { ...config, screens: kinOnlyScreens(config.screens, KIN_ONLY_ROUTES) },
  );
