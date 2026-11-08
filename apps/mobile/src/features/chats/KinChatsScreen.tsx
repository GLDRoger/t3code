import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { KinInboxPage } from "./components/KinScreenState";
import { selectKinInboxView } from "./state/kinInboxModel";
import { useKinInbox } from "./state/useKinInbox";

/** Placeholder chat list until MOB-3: Waiting on you and plain rows. */
export function KinChatsScreen() {
  const navigation = useNavigation();
  const { state, retry } = useKinInbox();
  return (
    <KinInboxPage title="Kin" state={state} onRetry={retry}>
      {(ready) => {
        const view = selectKinInboxView(ready.inbox.value);
        if (view.rows.length === 0) {
          return (
            <EmptyState
              title="No chats yet"
              detail="Your lead's chat appears here once Kin is set up."
            />
          );
        }
        return (
          <>
            {view.waitingCount > 0 ? (
              <View className="overflow-hidden rounded-[20px]">
                <ListRow
                  icon="exclamationmark.circle"
                  label="Waiting on you"
                  detail={String(view.waitingCount)}
                  onPress={() => navigation.navigate("KinWaiting")}
                />
              </View>
            ) : null}
            <View className="overflow-hidden rounded-[20px] bg-grouped-card">
              {view.rows.map((row) => (
                <View
                  key={row.chat.chatId}
                  accessible
                  accessibilityLabel={[
                    row.chat.title ?? "Direct chat",
                    row.chat.lastMessage?.body,
                    row.chat.unread > 0 ? `${row.chat.unread} unread` : undefined,
                  ]
                    .filter(Boolean)
                    .join(". ")}
                >
                  <ListRowLayout
                    icon="bubble.left"
                    label={row.chat.title ?? "Direct chat"}
                    description={row.chat.lastMessage?.body ?? "No messages yet"}
                    {...(row.chat.unread > 0 ? { detail: String(row.chat.unread) } : {})}
                  />
                </View>
              ))}
            </View>
          </>
        );
      }}
    </KinInboxPage>
  );
}
