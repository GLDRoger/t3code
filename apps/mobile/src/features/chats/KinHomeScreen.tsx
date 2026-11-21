import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { KIN_TEAMMATE_WELCOME } from "@t3tools/client-runtime/kin/kinChatListRows";
import { kinDockSelection, kinDockShown } from "@t3tools/client-runtime/kin/kinNavigation";
import { kinAttentionBadge } from "@t3tools/client-runtime/kin/kinAttention";
import { kinBadgeCount } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  kinAccessEndedCopy,
  kinDockTabs,
  type KinDockTab,
} from "@t3tools/client-runtime/kin/kinJoin";
import type { SessionGrantInput } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentCatalog } from "../../connection/catalog";
import { KIN_ONLY } from "../../lib/kinOnly";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { KinChatsList } from "./KinChatsScreen";
import { KinDock, kinDockClearance, type KinDockProps } from "./components/KinDock";
import { useKinTasksNeedsYou } from "./state/useKinAttention";
import { KinPlace } from "./KinWorkScreen";
import { KinTabContext, kinTabFoot } from "./components/KinTab";
import { kinHomeTabAtom } from "./state/kinHomeTab";
import { kinPlacesAtom, useKinAccessEnded, useKinAppShell } from "./state/kinChatOnly";
import { kinCachedDockAtom, saveKinDockAtom } from "./state/kinClient";
import { useKinHost } from "./state/useKinHost";
import { useKinInbox } from "./state/useKinInbox";
import type { KinWorkTarget } from "./state/useKinWork";

const ACCESS_ENDED = kinAccessEndedCopy("phone");

const noSessionAtom = Atom.make(null);

/**
 * Kin as the whole app: Chats, then each place of Work as a tab of the dock the coding workspace
 * uses, with Settings a button on Chats. A teammate, who can't read Work, gets Chats alone.
 */
export function KinHomeScreen() {
  const host = useKinHost();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const session = useAtomValue(
    host._tag === "host"
      ? environmentSession.sessionStateValueAtom(host.environmentId)
      : noSessionAtom,
  );
  const orgId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.orgId ?? null)
      : null;
  const workTarget =
    host._tag === "host" && orgId !== null ? { environmentId: host.environmentId, orgId } : null;

  if (KIN_ONLY && !catalog.isReady) return <View className="flex-1 bg-screen" />;
  if (KIN_ONLY && catalog.entries.size === 0) return <KinWelcome />;
  const chatsOnly =
    session !== null &&
    kinDockTabs(session, true, { money: false, clients: false, docs: false }).length === 1;
  if (workTarget === null || chatsOnly) {
    return <KinHomeTabs tabs={["chats"]} known={chatsOnly} workTarget={null} />;
  }
  return <KinHomeWithWork session={session} workTarget={workTarget} />;
}

/**
 * The dock for a viewer who may read Work: a place the host refuses them leaves it. Until the host
 * has said who this is (a cold start offline), the dock this device last drew stands in.
 */
function KinHomeWithWork(props: {
  readonly session: SessionGrantInput | null;
  readonly workTarget: KinWorkTarget;
}) {
  const { environmentId } = props.workTarget;
  const places = useAtomValue(kinPlacesAtom(props.workTarget));
  const live = props.session === null || !places.answered ? null : places.destinations;
  const cachedResult = useAtomValue(kinCachedDockAtom(environmentId));
  const cached = AsyncResult.getOrElse(cachedResult, () => null);
  const dock = kinDockShown({ live, cached });
  const save = useAtomSet(saveKinDockAtom);
  const liveKey = live?.join(",") ?? null;
  // A string, so the write runs once per change of dock, not once per render.
  const toSave =
    liveKey !== null && cachedResult._tag === "Success" && liveKey !== cached?.join(",")
      ? liveKey
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the live dock to device storage so a cold start offline keeps its places
  useEffect(() => {
    if (toSave !== null) save({ environmentId, tabs: kinDockTabsOf(toSave) });
  }, [toSave, environmentId, save]);
  return <KinHomeTabs tabs={dock.tabs} known={dock.known} workTarget={props.workTarget} />;
}

const kinDockTabsOf = (key: string) => key.split(",") as ReadonlyArray<KinDockTab>;

function KinHomeTabs(props: {
  readonly tabs: ReadonlyArray<KinDockTab>;
  /** The host has said which places these are; a cached or not-yet-known dock moves nobody. */
  readonly known: boolean;
  readonly workTarget: KinWorkTarget | null;
}) {
  const navigation = useNavigation();
  const { tabs, workTarget } = props;
  const teammate = useKinAppShell() === "chatOnly";
  const accessEnded = useKinAccessEnded().length > 0;
  const insets = useSafeAreaInsets();
  const held = useAtomValue(kinHomeTabAtom);
  const { shown: tab, leave } = kinDockSelection({ held: held.tab, tabs, known: props.known });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the host took the open place away: let it go, so switching it back on doesn't reopen it
  useEffect(() => {
    if (leave) {
      appAtomRegistry.set(kinHomeTabAtom, { ...appAtomRegistry.get(kinHomeTabAtom), tab: "chats" });
    }
  }, [leave]);
  const docked = tabs.length > 1;
  const bottomClearance = docked ? kinDockClearance(insets.bottom) : 0;
  const unread = useKinUnreadBadge();
  const select = (next: KinDockTab) =>
    appAtomRegistry.set(kinHomeTabAtom, { ...appAtomRegistry.get(kinHomeTabAtom), tab: next });
  const settings: AppBarAction = {
    accessibilityLabel: "Settings",
    icon: "gearshape",
    onPress: () => navigation.navigate("SettingsKin"),
  };
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {/* Home's route carries the coding workspace's brand title, and a tab's bar keeps what the
          last tab set (a place's search), so each tab starts from a clean bar. */}
      <NativeStackScreenOptions
        key={tab}
        options={{
          headerTitle: undefined,
          headerSearchBarOptions: undefined,
          unstable_headerToolbarItems: undefined,
        }}
      />
      <KinTabContext value={docked ? { bottomClearance } : null}>
        {tab !== "chats" && workTarget !== null ? (
          <KinPlace
            // Asked again to narrow Tasks, it starts again from what it was asked.
            key={`${tab}:${held.opened}`}
            {...workTarget}
            place={{ place: tab, projects: false }}
            party={tab === "tasks" ? (held.tasks?.party ?? null) : null}
            project={tab === "tasks" ? (held.tasks?.project ?? null) : null}
          />
        ) : accessEnded ? (
          <KinHomeMessage title="Kin" bottomClearance={bottomClearance} actions={[settings]}>
            <EmptyState
              variant="plain"
              title={ACCESS_ENDED.title}
              detail={ACCESS_ENDED.detail}
              actionLabel={ACCESS_ENDED.action}
              onAction={() => navigation.navigate("KinJoin")}
            />
          </KinHomeMessage>
        ) : (
          <KinChatsList
            bottomClearance={bottomClearance}
            actions={[settings]}
            {...(teammate ? { empty: KIN_TEAMMATE_WELCOME } : {})}
          />
        )}
      </KinTabContext>
      {!docked ? null : workTarget === null ? (
        <KinDock
          tabs={tabs}
          selectedTab={tab}
          onSelect={select}
          {...(unread === null ? {} : { badges: { chats: unread } })}
        />
      ) : (
        <KinBadgedDock
          {...workTarget}
          tabs={tabs}
          selectedTab={tab}
          onSelect={select}
          {...(unread === null ? {} : { badges: { chats: unread } })}
        />
      )}
    </View>
  );
}

/**
 * The dock, with unread messages counted on Chats, and on Tasks what Needs you holds: the same
 * number as that heading (`useKinTasksNeedsYou`).
 */
function KinBadgedDock(props: KinWorkTarget & KinDockProps) {
  const count = useKinTasksNeedsYou({ environmentId: props.environmentId, orgId: props.orgId });
  const badge = count === null ? null : kinAttentionBadge(count);
  return (
    <KinDock
      tabs={props.tabs}
      selectedTab={props.selectedTab}
      onSelect={props.onSelect}
      badges={{ ...props.badges, ...(badge === null ? {} : { tasks: badge }) }}
    />
  );
}

/** The Chats list's unread total, the same count as the app icon's badge. */
function useKinUnreadBadge() {
  const { host, state } = useKinInbox();
  const known = state._tag === "ready" ? kinBadgeCount(state.inbox.value) : null;
  // Offline before the inbox is read again, the badge keeps the last number it showed.
  const key = host._tag === "host" ? host.environmentId : null;
  const [last, setLast] = useState({ key, count: known });
  if (known !== null && (known !== last.count || key !== last.key)) setLast({ key, count: known });
  const count = known ?? (last.key === key ? last.count : null);
  return count === null ? null : kinAttentionBadge(count);
}

/** A tab's state that isn't its list, inside the scroll view that clears the floating bar. */
function KinHomeMessage(props: {
  readonly title: string;
  readonly bottomClearance: number;
  readonly actions?: ReadonlyArray<AppBarAction> | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <>
      <AppBar title={props.title} actions={props.actions} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            padding: 16,
            paddingBottom: kinTabFoot(props.bottomClearance),
            gap: 12,
          }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </>
  );
}

/** First run of a Kin-only app: the two ways in, and nothing about coding. */
function KinWelcome() {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ headerTitle: undefined }} />
      <AppBar title="Kin" />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 16 }}
        >
          <EmptyState
            variant="plain"
            title="Welcome to Kin"
            detail="Joining a team? Use the link they sent you. Running your own Kin? Connect this phone to the computer it runs on."
            action={
              <View className="items-center gap-3">
                <Button
                  tone="primary"
                  label="I have a join link"
                  onPress={() => navigation.navigate("KinJoin")}
                />
                <Button
                  tone="secondary"
                  label="Set up my own Kin"
                  onPress={() => navigation.navigate("ConnectionsNew")}
                />
              </View>
            }
          />
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
