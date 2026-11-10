import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { KinChatRow, KinChatRowSkeletons } from "./components/KinChatRow";
import { KinInboxNotice, KinScreenState } from "./components/KinScreenState";
import { KinWaitingBanner } from "./components/KinWaitingBanner";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinChatListRowLabel, kinChatListRows } from "@t3tools/client-runtime/kin/kinChatListRows";
import {
  formatKinTime,
  kinDirectory,
  kinWaitingBannerView,
  type KinChatRowView,
  type KinDirectory,
  type KinInboxScreenState,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinInbox } from "./state/useKinInbox";

export function KinChatsScreen() {
  const navigation = useNavigation();
  const { host, state, retry } = useKinInbox();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title="Kin" onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <KinChatsView
          state={state}
          directory={kinDirectory(host)}
          onRetry={retry}
          onOpenWaiting={() => navigation.navigate("KinWaiting")}
          onOpenChat={(chatId) => {
            if (state._tag !== "ready") return;
            const chat = state.inbox.value.chats.find((held) => held.chatId === chatId);
            if (chat === undefined) return;
            navigation.navigate("KinChat", {
              environmentId: state.environmentId,
              orgId: chat.orgId,
              chatId,
            });
          }}
        />
      </ScreenContent>
    </View>
  );
}

/** The chat list for one inbox state. Also rendered from fixtures in the component catalog. */
export function KinChatsView(props: {
  readonly state: KinInboxScreenState;
  readonly directory: KinDirectory;
  readonly onRetry: () => void;
  readonly onOpenWaiting: () => void;
  readonly onOpenChat: (chatId: KinChatRowView["chatId"]) => void;
}) {
  const { state, onOpenChat } = props;
  const view = state._tag === "ready" ? selectKinInboxView(state.inbox.value) : null;
  const banner = view === null ? null : kinWaitingBannerView(view.waiting);
  // The stale notice only shows over a cached inbox; an empty header would still pad the list.
  const notice = state._tag === "ready" && !(state.connected && state.inbox.live);
  if (state._tag !== "ready" || view === null || view.rows.length === 0) {
    return (
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 12 }}
      >
        <KinScreenState state={state} onRetry={props.onRetry} loading={<KinChatRowSkeletons />}>
          {() => (
            <>
              {banner === null ? null : (
                <KinWaitingBanner view={banner} onPress={props.onOpenWaiting} />
              )}
              <EmptyState title="No chats yet" detail="Chats with your leads show up here." />
            </>
          )}
        </KinScreenState>
      </ScreenScrollView>
    );
  }
  const rows = kinChatListRows(view, props.directory);
  return (
    <LegendList
      renderScrollComponent={NativeScrollView}
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}
      data={rows}
      keyExtractor={(row) => row.chat.chatId}
      estimatedItemSize={76}
      recycleItems
      renderItem={({ item, index }) => (
        <>
          <KinChatRow
            row={item}
            accessibilityLabel={kinChatListRowLabel(item, (date) => formatKinTime(date))}
            onPress={() => onOpenChat(item.chat.chatId)}
          />
          {index < rows.length - 1 ? <View className="ml-[76px] h-px bg-border-subtle" /> : null}
        </>
      )}
      ListHeaderComponent={
        notice || banner !== null ? (
          <View className="gap-3 px-4 pb-2 pt-2">
            <KinInboxNotice state={state} />
            {banner === null ? null : (
              <KinWaitingBanner view={banner} onPress={props.onOpenWaiting} />
            )}
          </View>
        ) : null
      }
    />
  );
}
