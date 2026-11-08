import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";

type KinChatParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly chatId: string;
};

/** Placeholder until MOB-4's feed, so the chat list, Waiting on you and links can open a chat. */
export function KinChatScreen(_props: StaticScreenProps<KinChatParams>) {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title="Chat" onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <View className="flex-1 justify-center p-4">
          <EmptyState
            variant="plain"
            title="Chats open in the next build"
            detail="Update the app to read and reply here."
          />
        </View>
      </ScreenContent>
    </View>
  );
}
