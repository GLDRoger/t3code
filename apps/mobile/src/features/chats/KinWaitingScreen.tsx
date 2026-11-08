import type { KinWaitingReason } from "@t3tools/contracts";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { KinInboxPage } from "./components/KinScreenState";
import { selectKinInboxView } from "./state/kinInboxModel";
import { useKinInbox } from "./state/useKinInbox";

const REASON_LABELS: Record<KinWaitingReason, string> = {
  approval: "Approval",
  decision: "Decision",
  question: "Question",
  suggestion: "Suggestion",
  mention: "Mention",
};

/** Placeholder Waiting on you until the native cards land: one row per item, oldest first. */
export function KinWaitingScreen() {
  const { state, retry } = useKinInbox();
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
        const chatTitles = new Map(view.rows.map((row) => [row.chat.chatId, row.chat.title]));
        return (
          <ListSection>
            {view.waiting.map((item) => {
              const label = REASON_LABELS[item.reason];
              const chat = chatTitles.get(item.chatId) ?? "Direct chat";
              return (
                <View key={item.waitingId} accessible accessibilityLabel={`${label}, in ${chat}`}>
                  <ListRowLayout icon="exclamationmark.circle" label={label} description={chat} />
                </View>
              );
            })}
          </ListSection>
        );
      }}
    </KinInboxPage>
  );
}
