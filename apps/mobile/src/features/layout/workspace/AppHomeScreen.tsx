import { View } from "react-native";

import { KinHomeScreen } from "../../chats/KinChatsScreen";
import { useKinAppShell } from "../../chats/state/kinChatOnly";
import { WorkspaceRootScreen } from "./WorkspaceRootScreen";

/** Home is the coding workspace, or only Kin on a phone that holds nothing but a teammate's session. */
export function AppHomeScreen() {
  const shell = useKinAppShell();
  if (shell === "loading") return <View className="flex-1 bg-screen" />;
  return shell === "chatOnly" ? <KinHomeScreen /> : <WorkspaceRootScreen />;
}
