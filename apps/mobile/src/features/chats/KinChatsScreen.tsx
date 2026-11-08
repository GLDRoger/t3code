import { useNavigation } from "@react-navigation/native";

import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { KinInboxPage } from "./components/KinScreenState";
import { selectKinInboxView } from "./state/kinInboxModel";
import { kinChatTitle, kinDirectory } from "./state/kinScreenState";
import { useKinInbox } from "./state/useKinInbox";

/** Placeholder chat list until MOB-3: Waiting on you and plain rows. */
export function KinChatsScreen() {
  const navigation = useNavigation();
  const { host, state, retry } = useKinInbox();
  const { agentNames } = kinDirectory(host);
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
              <ListSection>
                <ListRow
                  icon="exclamationmark.circle"
                  label="Waiting on you"
                  detail={String(view.waitingCount)}
                  onPress={() => navigation.navigate("KinWaiting")}
                />
              </ListSection>
            ) : null}
            <ListSection>
              {view.rows.map((row) => {
                const title = kinChatTitle(row.chat, agentNames);
                return (
                  <ListRow
                    key={row.chat.chatId}
                    icon="bubble.left"
                    label={title}
                    description={row.chat.lastMessage?.body ?? "No messages yet"}
                    {...(row.chat.unread > 0 ? { detail: `${row.chat.unread} unread` } : {})}
                    onPress={() =>
                      navigation.navigate("KinChat", {
                        environmentId: ready.environmentId,
                        orgId: row.chat.orgId,
                        chatId: row.chat.chatId,
                      })
                    }
                  />
                );
              })}
            </ListSection>
          </>
        );
      }}
    </KinInboxPage>
  );
}
