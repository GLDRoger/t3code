import { View } from "react-native";

import { KinHomeScreen } from "../../chats/KinHomeScreen";
import { useKinHome } from "../../chats/state/kinHome";
import { WorkspaceRootScreen } from "./WorkspaceRootScreen";

/**
 * Home is the coding workspace, or only Kin: in a Kin-only build, on a phone that holds nothing
 * but a teammate's session, and wherever a host runs Kin.
 */
export function AppHomeScreen() {
  const home = useKinHome();
  if (home === "loading") return <View className="flex-1 bg-screen" />;
  return home === "kin" ? <KinHomeScreen /> : <WorkspaceRootScreen />;
}
