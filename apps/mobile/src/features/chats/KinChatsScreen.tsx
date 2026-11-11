import { LegendList } from "@legendapp/list/react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { kinHomeTabs, type KinHomeTab } from "@t3tools/client-runtime/kin/kinJoin";
import { Atom } from "effect/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarProps } from "../../components/ui/AppBar.types";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { KinMemoryEntry } from "./KinMemoryScreen";
import { KinTeamEntry } from "./KinTeamScreen";
import { KinWorkEntry } from "./KinWorkScreen";
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
import { useKinAccessEnded } from "./state/kinChatOnly";
import { rememberKinListAtom } from "./state/kinLastList";
import { useKinHost } from "./state/useKinHost";
import { useKinInbox } from "./state/useKinInbox";
import { KinTeammateSettings } from "./KinTeammateSettings";
import { environmentSession } from "../../state/session";
import { SidebarTabBar } from "../layout/workspace/WorkspaceSidebarTabs";
import { useFloatingWorkspaceTabs } from "../layout/workspace/useSystemWorkspaceTabBar";
import { workspaceDockBottomClearance } from "../layout/workspace/workspace-tabs-state";

/** The Kin list as a page over coding threads: opening and leaving it is the switch between them. */
export function KinChatsScreen() {
  const navigation = useNavigation();
  const rememberList = useAtomSet(rememberKinListAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records in device storage which list is open, so the next launch opens to it
  useEffect(() => {
    rememberList("kin");
    // Leaving the list, by Back or the swipe, is the switch back to coding threads.
    return navigation.addListener("beforeRemove", () => rememberList("threads"));
  }, [navigation, rememberList]);
  return <KinChatsList onBack={() => navigation.goBack()} />;
}

/** The dock's own names for the tabs it can draw; a Kin tab without one waits for its icon. */
const KIN_DOCK_TABS: Partial<Record<KinHomeTab, string>> = {
  chats: "threads",
  settings: "settings",
};
const noSessionAtom = Atom.make(null);

/**
 * Kin as the whole app, on a phone that only holds a teammate's session: the chat list and
 * Settings as tabs of the same dock the coding workspace uses, with the tabs the session allows.
 */
export function KinHomeScreen() {
  const navigation = useNavigation();
  const host = useKinHost();
  const session = useAtomValue(
    host._tag === "host"
      ? environmentSession.sessionStateValueAtom(host.environmentId)
      : noSessionAtom,
  );
  const accessEnded = useKinAccessEnded().length > 0;
  const insets = useSafeAreaInsets();
  const compact = useFloatingWorkspaceTabs();
  const [tab, setTab] = useState<KinHomeTab>("chats");
  // Android has no dock here yet, so Settings stays a button in the bar.
  const docked = Platform.OS === "ios";
  const tabs = kinHomeTabs(session).filter((candidate) => KIN_DOCK_TABS[candidate] !== undefined);
  const bottomClearance = docked
    ? workspaceDockBottomClearance({ bottomInset: insets.bottom, keyboardHeight: 0 })
    : 0;
  const actions = docked
    ? undefined
    : [
        {
          accessibilityLabel: "Settings",
          icon: "gearshape",
          onPress: () => navigation.navigate("Settings"),
        } as const,
      ];
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {tab === "settings" ? (
        <KinTeammateSettings tab={{ bottomClearance }} />
      ) : accessEnded ? (
        <>
          <NativeStackScreenOptions options={{ headerTitle: undefined }} />
          <AppBar title="Kin" actions={actions} />
          <ScreenContent surface="screen">
            <ScreenScrollView
              className="flex-1"
              contentInsetAdjustmentBehavior="automatic"
              contentContainerStyle={{ padding: 16, gap: 12 }}
            >
              <EmptyState
                variant="plain"
                title="You no longer have access"
                detail="Your team's Kin signed this phone out. Ask them for a new join link to get back in."
                actionLabel="Join with a new link"
                onAction={() => navigation.navigate("KinJoin")}
              />
            </ScreenScrollView>
          </ScreenContent>
        </>
      ) : (
        <KinChatsList home bottomClearance={bottomClearance} actions={actions} />
      )}
      {docked ? (
        <View
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 128 }}
        >
          <SidebarTabBar
            compact={compact}
            reserveComposeSpace={false}
            tabs={tabs}
            selectedTab={tab}
            onSelect={setTab}
            nativeTab={(candidate) => KIN_DOCK_TABS[candidate] ?? candidate}
          />
        </View>
      ) : null}
    </View>
  );
}

function KinChatsList({
  home,
  bottomClearance = 0,
  ...bar
}: Pick<AppBarProps, "onBack" | "actions"> & {
  readonly home?: boolean;
  readonly bottomClearance?: number;
}) {
  const navigation = useNavigation();
  const { host, state, retry } = useKinInbox();
  const orgId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.orgId ?? null)
      : null;
  const newLeadAt =
    state._tag === "ready" && orgId !== null ? { environmentId: state.environmentId, orgId } : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {/* Home's route carries the coding workspace's brand title; the Kin list draws its own. */}
      {home ? <NativeStackScreenOptions options={{ headerTitle: undefined }} /> : null}
      {newLeadAt === null ? (
        <AppBar title="Kin" {...bar} />
      ) : (
        <KinChatsBar environmentId={newLeadAt.environmentId} orgId={newLeadAt.orgId} bar={bar} />
      )}
      <ScreenContent surface="screen">
        <KinChatsView
          state={state}
          directory={kinDirectory(host)}
          onRetry={retry}
          bottomClearance={bottomClearance}
          {...(home
            ? { emptyDetail: "When someone on your team starts a chat with you, it shows up here." }
            : {})}
          memory={
            newLeadAt === null ? null : (
              <>
                <KinWorkEntry environmentId={newLeadAt.environmentId} orgId={newLeadAt.orgId} />
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
function KinChatsBar(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly bar: Pick<AppBarProps, "onBack" | "actions">;
}) {
  const navigation = useNavigation();
  const canAddLead = useAtomValue(kinClient.leadCreate.permissionAtom(props.environmentId));
  const canAddGroup = useAtomValue(kinClient.groupCreate.permissionAtom(props.environmentId));
  const canAddTeammate = useAtomValue(kinClient.inviteCreate.permissionAtom(props.environmentId));
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  return (
    <AppBar
      title="Kin"
      {...props.bar}
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
  /** What an empty list says, for a viewer who can't start chats with leads. */
  readonly emptyDetail?: string;
  /** Room under the last row for a tab dock drawn over the list. */
  readonly bottomClearance?: number;
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
        contentContainerStyle={{
          padding: 16,
          paddingBottom: 16 + (props.bottomClearance ?? 0),
          gap: 12,
        }}
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
              <EmptyState
                title="No chats yet"
                detail={props.emptyDetail ?? "Chats with your leads show up here."}
              />
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
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 + (props.bottomClearance ?? 0) }}
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
