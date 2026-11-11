import { useNavigation } from "@react-navigation/native";
import { kinApprovalActionIdOf } from "@t3tools/contracts";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { KinInboxPage } from "./components/KinScreenState";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  formatKinTime,
  kinDirectory,
  kinWaitingRowView,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinInbox } from "./state/useKinInbox";
import { KinApprovalCard } from "./widgets/KinApprovalCard";

/** Waiting on you, oldest first: approvals as their full cards, everything else as a row. */
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
              detail="Approvals and questions from your agents show up here."
            />
          );
        }
        const openChat = (item: (typeof view.waiting)[number]) =>
          navigation.navigate("KinChat", {
            environmentId: ready.environmentId,
            orgId: item.orgId,
            chatId: item.chatId,
          });
        const approvals = view.waiting.flatMap((item) => {
          const actionId =
            item.reason === "approval" && item.widgetId !== null
              ? kinApprovalActionIdOf(item.widgetId)
              : null;
          return actionId === null ? [] : [{ item, actionId }];
        });
        const rest = view.waiting.filter(
          (item) => !approvals.some((approval) => approval.item.waitingId === item.waitingId),
        );
        return (
          <>
            {approvals.map(({ item, actionId }) => (
              <View key={item.waitingId} className="gap-1">
                <KinApprovalCard
                  environmentId={ready.environmentId}
                  actionId={actionId}
                  revision={0}
                />
                <View className="flex-row">
                  <Button
                    tone="text"
                    size="compact"
                    label="Open in chat"
                    onPress={() => openChat(item)}
                  />
                </View>
              </View>
            ))}
            {rest.length === 0 ? null : (
              <ListSection>
                {rest.map((item) => {
                  const row = kinWaitingRowView(item, ready.inbox.value.chats, agentNames);
                  return (
                    <ListRow
                      key={item.waitingId}
                      icon="exclamationmark.circle"
                      label={`${row.label} · ${row.chatTitle}`}
                      description={row.text ?? `Open the chat with ${row.chatTitle}`}
                      detail={formatKinTime(new Date(row.createdAt))}
                      onPress={() => openChat(item)}
                    />
                  );
                })}
              </ListSection>
            )}
          </>
        );
      }}
    </KinInboxPage>
  );
}
