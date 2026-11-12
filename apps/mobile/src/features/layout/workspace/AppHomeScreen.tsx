import { View } from "react-native";

import { KinHomeScreen } from "../../chats/KinHomeScreen";
import { useKinAppShell } from "../../chats/state/kinChatOnly";
import { KIN_ONLY } from "../../../lib/kinOnly";
import { WorkspaceRootScreen } from "./WorkspaceRootScreen";

/**
 * Home is the coding workspace, or only Kin: in a Kin-only build, and on a phone that holds
 * nothing but a teammate's session.
 */
export function AppHomeScreen() {
  const shell = useKinAppShell();
  if (shell === "loading") return <View className="flex-1 bg-screen" />;
  return KIN_ONLY || shell === "chatOnly" ? <KinHomeScreen /> : <WorkspaceRootScreen />;
}
