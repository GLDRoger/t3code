import { useNavigation } from "@react-navigation/native";

import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { KinInboxPage } from "./components/KinScreenState";
import { selectKinInboxView } from "./state/kinInboxModel";
import { formatKinTime, kinDirectory, kinWaitingRowView } from "./state/kinScreenState";
import { useKinInbox } from "./state/useKinInbox";

/** Placeholder Waiting on you until the native cards land: one row per item, oldest first. */
export function KinWaitingScreen() {
  const navigation = useNavigation();
  const { host, state, retry } = useKinInbox();
  const { agentNames } = kinDirectory(host);
  return (
    <KinInboxPage title="Waiting on you" state={state} onRetry={retry}>
      {(ready) => {
        const view = selectKinInboxView(ready.inbox.value);
        if (view.waiting.length === 0) {
          return (
            <EmptyState
              variant="plain"
              title="Nothing is waiting on you."
              detail="Approvals and questions from your leads show up here."
            />
          );
        }
        return (
          <ListSection>
            {view.waiting.map((item) => {
              const row = kinWaitingRowView(item, ready.inbox.value.chats, agentNames);
              return (
                <ListRow
                  key={item.waitingId}
                  icon="exclamationmark.circle"
                  label={`${row.label} · ${row.chatTitle}`}
                  description={row.text ?? `Open the chat with ${row.chatTitle}`}
                  detail={formatKinTime(new Date(row.createdAt))}
                  onPress={() =>
                    navigation.navigate("KinChat", {
                      environmentId: ready.environmentId,
                      orgId: item.orgId,
                      chatId: item.chatId,
                    })
                  }
                />
              );
            })}
          </ListSection>
        );
      }}
    </KinInboxPage>
  );
}
