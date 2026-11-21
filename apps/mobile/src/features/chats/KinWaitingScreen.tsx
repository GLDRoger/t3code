import { KIN_CHAT_COPY } from "@t3tools/client-runtime/kin/kinChatFeed";
import { useNavigation } from "@react-navigation/native";
import { kinApprovalActionIdOf } from "@t3tools/contracts";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { KinInboxPage } from "./components/KinScreenState";
import { KIN_WAITING_TITLE, selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  formatKinTime,
  kinDirectory,
  kinWaitingRowView,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinInbox } from "./state/useKinInbox";
import { kinWaitingAskView } from "@t3tools/client-runtime/kin/kinWaitingAsk";
import { useNowMinuteMs } from "../../lib/clock";
import { KinWaitingAsk } from "./components/KinWaitingAsk";
import { KinApprovalCard } from "./widgets/KinApprovalCard";

/**
 * Waiting on you, oldest first: approvals as their full cards, an agent's open question with its
 * default, day and answers, everything else as a row.
 */
export function KinWaitingScreen() {
  const navigation = useNavigation();
  const { host, state, retry } = useKinInbox();
  const { agentNames } = kinDirectory(host);
  const nowMs = useNowMinuteMs();
  return (
    <KinInboxPage title={KIN_WAITING_TITLE} state={state} onRetry={retry}>
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
        // An agent's open question shows what it will do and when, with its answers to tap.
        const asks = rest.flatMap((item) => {
          const ask = kinWaitingAskView(item, nowMs);
          return ask === null ? [] : [{ item, ask }];
        });
        const plain = rest.filter(
          (item) => !asks.some((one) => one.item.waitingId === item.waitingId),
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
            {asks.map(({ item, ask }) => {
              const row = kinWaitingRowView(item, ready.inbox.value.chats, agentNames);
              return (
                <ListSection key={item.waitingId}>
                  <ListRow
                    icon="questionmark.bubble"
                    label={`${row.label} · ${row.chatTitle}`}
                    description={row.text ?? KIN_CHAT_COPY.openChatWith(row.chatTitle)}
                    detail={formatKinTime(new Date(row.createdAt))}
                    onPress={() => openChat(item)}
                  />
                  <KinWaitingAsk ask={ask} environmentId={ready.environmentId} />
                </ListSection>
              );
            })}
            {plain.length === 0 ? null : (
              <ListSection>
                {plain.map((item) => {
                  const row = kinWaitingRowView(item, ready.inbox.value.chats, agentNames);
                  return (
                    <ListRow
                      key={item.waitingId}
                      icon="exclamationmark.circle"
                      label={`${row.label} · ${row.chatTitle}`}
                      description={row.text ?? KIN_CHAT_COPY.openChatWith(row.chatTitle)}
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
