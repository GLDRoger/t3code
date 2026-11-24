import { KIN_CHAT_COPY } from "@t3tools/client-runtime/kin/kinChatFeed";
import { useNavigation } from "@react-navigation/native";
import { kinApprovalActionIdOf } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { KinInboxPage } from "./components/KinScreenState";
import { KIN_WAITING_TITLE, selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  formatKinTime,
  KIN_WAITS_FOR_COPY,
  kinDirectory,
  kinWaitingRowView,
  kinWaitsForDetail,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinInboxOpen } from "./state/useKinInboxOpen";
import { kinWaitingAskView } from "@t3tools/client-runtime/kin/kinWaitingAsk";
import { useNowMinuteMs } from "../../lib/clock";
import { KinWaitingAsk } from "./components/KinWaitingAsk";
import { KinFoldSection } from "./components/KinWorkPieces";
import { KinWaitsForRow } from "./components/KinWaitsForRow";
import { KinApprovalCard } from "./widgets/KinApprovalCard";

/**
 * Waiting on you, oldest first: approvals as their full cards, an agent's open question with its
 * default, day and answers, everything else as a row. Then, folded, what waits on someone else
 * that the viewer may see, to look at only.
 */
export function KinWaitingScreen() {
  const navigation = useNavigation();
  const { host, state, retry, reread } = useKinInboxOpen();
  const { agentNames } = kinDirectory(host);
  const nowMs = useNowMinuteMs();
  return (
    <KinInboxPage title={KIN_WAITING_TITLE} state={state} onRetry={retry}>
      {(ready) => {
        const view = selectKinInboxView(ready.inbox.value);
        const others = view.waitsFor.map((group) => (
          <KinFoldSection
            key={group.personId}
            title={KIN_WAITS_FOR_COPY.fold(group.name, group.items.length)}
            summary={null}
          >
            {group.items.map((item) => (
              <KinWaitsForRow
                key={item.waitingId}
                row={kinWaitingRowView(item, ready.inbox.value.chats, agentNames)}
                detail={kinWaitsForDetail(item)}
                when={formatKinTime(new Date(item.createdAt))}
              />
            ))}
          </KinFoldSection>
        ));
        if (view.waiting.length === 0) {
          return (
            <>
              <EmptyState
                variant="plain"
                title="Nothing is waiting on you."
                detail="Approvals and questions from your agents show up here."
              />
              {others}
            </>
          );
        }
        const openChat = (item: (typeof view.waiting)[number]) =>
          navigation.navigate("KinChat", {
            environmentId: ready.environmentId,
            orgId: item.orgId,
            chatId: item.chatId,
            ...(item.messageId === null ? {} : { message: item.messageId }),
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
                    meta={<KinWaitingExcerpt text={row.excerpt} />}
                    onPress={() => openChat(item)}
                  />
                  <KinWaitingAsk
                    ask={ask}
                    item={item}
                    environmentId={ready.environmentId}
                    onReread={reread}
                  />
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
                      meta={<KinWaitingExcerpt text={row.excerpt} />}
                      onPress={() => openChat(item)}
                    />
                  );
                })}
              </ListSection>
            )}
            {others}
          </>
        );
      }}
    </KinInboxPage>
  );
}

/** A draft's or doc's first lines under its row, so it can be read before the answer. */
function KinWaitingExcerpt(props: { readonly text: string | null }) {
  if (props.text === null) return null;
  return (
    <Text textRole="footnote" numberOfLines={3} className="text-foreground-secondary">
      {props.text}
    </Text>
  );
}
