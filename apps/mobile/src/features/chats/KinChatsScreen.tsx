import { LegendList } from "@legendapp/list/react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { KinMemoryEntry } from "./KinMemoryScreen";
import { KinTeamEntry } from "./KinTeamScreen";
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
import { kinClient } from "./state/kinClient";
import { rememberKinListAtom } from "./state/kinLastList";
import { useKinInbox } from "./state/useKinInbox";

export function KinChatsScreen() {
  const navigation = useNavigation();
  const { host, state, retry } = useKinInbox();
  const rememberList = useAtomSet(rememberKinListAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records in device storage which list is open, so the next launch opens to it
  useEffect(() => {
    rememberList("kin");
    // Leaving the list, by Back or the swipe, is the switch back to coding threads.
    return navigation.addListener("beforeRemove", () => rememberList("threads"));
  }, [navigation, rememberList]);
  const orgId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.orgId ?? null)
      : null;
  const newLeadAt =
    state._tag === "ready" && orgId !== null ? { environmentId: state.environmentId, orgId } : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {newLeadAt === null ? (
        <AppBar title="Kin" onBack={() => navigation.goBack()} />
      ) : (
        <KinChatsBar environmentId={newLeadAt.environmentId} orgId={newLeadAt.orgId} />
      )}
      <ScreenContent surface="screen">
        <KinChatsView
          state={state}
          directory={kinDirectory(host)}
          onRetry={retry}
          memory={
            newLeadAt === null ? null : (
              <>
                <KinMemoryEntry environmentId={newLeadAt.environmentId} orgId={newLeadAt.orgId} />
                <KinTeamEntry environmentId={newLeadAt.environmentId} orgId={newLeadAt.orgId} />
              </>
            )
          }
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

/** The list's bar with its "+": a new group or a new lead, for a viewer this host lets make them. */
function KinChatsBar(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const navigation = useNavigation();
  const canAddLead = useAtomValue(kinClient.leadCreate.permissionAtom(props.environmentId));
  const canAddGroup = useAtomValue(kinClient.groupCreate.permissionAtom(props.environmentId));
  const canAddTeammate = useAtomValue(kinClient.inviteCreate.permissionAtom(props.environmentId));
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  return (
    <AppBar
      title="Kin"
      onBack={() => navigation.goBack()}
      menus={
        canAddLead || canAddGroup || canAddTeammate
          ? [
              {
                title: "New",
                icon: "plus",
                items: [
                  ...(canAddGroup
                    ? [
                        {
                          id: "group",
                          title: "New group",
                          icon: "person.2",
                          onPress: () => navigation.navigate("KinGroupForm", target),
                        },
                      ]
                    : []),
                  ...(canAddLead
                    ? [
                        {
                          id: "lead",
                          title: "New lead",
                          icon: "sparkles",
                          onPress: () => navigation.navigate("KinLeadForm", target),
                        },
                      ]
                    : []),
                  ...(canAddTeammate
                    ? [
                        {
                          id: "teammate",
                          title: "Add teammate",
                          icon: "person.badge.plus",
                          onPress: () => navigation.navigate("KinInvite", target),
                        },
                      ]
                    : []),
                ],
              },
            ]
          : undefined
      }
    />
  );
}

/** The chat list for one inbox state. Also rendered from fixtures in the component catalog. */
export function KinChatsView(props: {
  readonly state: KinInboxScreenState;
  readonly directory: KinDirectory;
  readonly onRetry: () => void;
  /** The owner's way in to what the leads remember, above the chats. */
  readonly memory?: ReactNode;
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
                <View className="-mx-4">
                  <KinWaitingBanner view={banner} onPress={props.onOpenWaiting} />
                </View>
              )}
              {props.memory == null ? null : <View className="-mx-4">{props.memory}</View>}
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
      estimatedItemSize={64}
      recycleItems
      renderItem={({ item, index }) => (
        <>
          <KinChatRow
            row={item}
            accessibilityLabel={kinChatListRowLabel(item, (date) => formatKinTime(date))}
            onPress={() => onOpenChat(item.chat.chatId)}
          />
          {index < rows.length - 1 ? <View className="ml-5 h-px bg-border-subtle" /> : null}
        </>
      )}
      ListHeaderComponent={
        notice || banner !== null || props.memory != null ? (
          <>
            {notice ? (
              <View className="px-4 pb-2 pt-2">
                <KinInboxNotice state={state} />
              </View>
            ) : null}
            {banner === null ? null : (
              <>
                <KinWaitingBanner view={banner} onPress={props.onOpenWaiting} />
                <View className="ml-5 h-px bg-border-subtle" />
              </>
            )}
            {props.memory}
          </>
        ) : null
      }
    />
  );
}
