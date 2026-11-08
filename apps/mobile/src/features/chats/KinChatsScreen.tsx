import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { KinAskRow, KinChatRow, KinChatRowSkeletons } from "./components/KinChatRow";
import { KinInboxNotice, KinScreenState } from "./components/KinScreenState";
import { KinWaitingBanner } from "./components/KinWaitingBanner";
import { selectKinInboxView } from "./state/kinInboxModel";
import {
  formatKinTime,
  kinChatRowLabel,
  kinChatRowView,
  kinDirectory,
  kinLeadChatId,
  kinWaitingBannerView,
  type KinChatRowView,
  type KinDirectory,
  type KinInboxScreenState,
} from "./state/kinScreenState";
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
  /** Unset until the direct chat screen (MOB-4) exists; rows and the footer are then static. */
  readonly onOpenChat?: (chatId: KinChatRowView["chatId"]) => void;
}) {
  const { state, onOpenChat } = props;
  const view = state._tag === "ready" ? selectKinInboxView(state.inbox.value) : null;
  const banner = view === null ? null : kinWaitingBannerView(view.waiting);
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
              <EmptyState
                title="No chats yet"
                detail="Your lead's chat appears here once Kin is set up."
              />
            </>
          )}
        </KinScreenState>
      </ScreenScrollView>
    );
  }
  const leadChatId = kinLeadChatId(view.rows);
  const rows = view.rows.map((row) => kinChatRowView(row, props.directory));
  return (
    <LegendList
      renderScrollComponent={NativeScrollView}
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 16 }}
      data={rows}
      keyExtractor={(row) => row.chatId}
      estimatedItemSize={72}
      recycleItems
      renderItem={({ item }) => (
        <KinChatRow
          view={item}
          accessibilityLabel={kinChatRowLabel(item, (date) => formatKinTime(date))}
          {...(onOpenChat === undefined ? {} : { onPress: () => onOpenChat(item.chatId) })}
        />
      )}
      ItemSeparatorComponent={KinRowDivider}
      ListHeaderComponent={
        <View className="gap-3 px-4 pb-2 pt-2">
          <KinInboxNotice state={state} />
          {banner === null ? null : (
            <KinWaitingBanner view={banner} onPress={props.onOpenWaiting} />
          )}
        </View>
      }
      ListFooterComponent={
        <KinAskRow
          {...(onOpenChat === undefined || leadChatId === null
            ? {}
            : { onPress: () => onOpenChat(leadChatId) })}
        />
      }
    />
  );
}

function KinRowDivider() {
  return <View className="ml-[68px] h-px bg-border-subtle" />;
}
