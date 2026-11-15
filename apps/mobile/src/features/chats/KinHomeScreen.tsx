import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { KIN_TEAMMATE_WELCOME } from "@t3tools/client-runtime/kin/kinChatListRows";
import { kinAttentionBadge, kinAttentionCount } from "@t3tools/client-runtime/kin/kinAttention";
import { kinDockTabs, type KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";
import { kinWorkHostClients } from "@t3tools/client-runtime/kin/kinWork";
import type { SessionGrantInput } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
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
import { useKinAttention } from "./state/useKinAttention";
import { KinPlace } from "./KinWorkScreen";
import { KinTabContext } from "./components/KinTab";
import { kinHomeTabAtom } from "./state/kinHomeTab";
import {
  useKinAccessEnded,
  useKinAppShell,
  useKinOwnerLevel,
  useKinPlaceReach,
} from "./state/kinChatOnly";
import { useKinDocsLive } from "./state/useKinDocs";
import { useKinHost } from "./state/useKinHost";
import { useKinMoneySummary } from "./state/useKinMoney";
import { useKinWork, type KinWorkTarget } from "./state/useKinWork";

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
  const chatsOnly = kinDockTabs(session, true, { money: false, clients: false, docs: false });
  if (workTarget === null || chatsOnly.length === 1) {
    return <KinHomeTabs tabs={["chats"]} workTarget={null} />;
  }
  return <KinHomeWithWork session={session} workTarget={workTarget} />;
}

/** The dock for a viewer who may read Work: a place the host refuses them leaves it. */
function KinHomeWithWork(props: {
  readonly session: SessionGrantInput | null;
  readonly workTarget: KinWorkTarget;
}) {
  const work = useKinWork(props.workTarget);
  const seq = work._tag === "ready" && !work.stale ? work.live.seq : null;
  const money = useKinMoneySummary(props.workTarget, { enabled: true, seq }).state;
  const docs = useKinDocsLive(props.workTarget);
  const ownerLevel = useKinOwnerLevel(props.workTarget.environmentId, props.session);
  const reach = useKinPlaceReach(props.workTarget.environmentId);
  const tabs = kinDockTabs(
    props.session,
    ownerLevel,
    {
      money: money._tag === "refused",
      // Only an answer from an older host takes Clients away, never one still on its way.
      clients: work._tag === "ready" && !kinWorkHostClients(work.live.summary),
      docs: docs.refused,
    },
    reach,
  );
  return <KinHomeTabs tabs={tabs} workTarget={props.workTarget} />;
}

function KinHomeTabs(props: {
  readonly tabs: ReadonlyArray<KinDockTab>;
  readonly workTarget: KinWorkTarget | null;
}) {
  const navigation = useNavigation();
  const { tabs, workTarget } = props;
  const teammate = useKinAppShell() === "chatOnly";
  const accessEnded = useKinAccessEnded().length > 0;
  const insets = useSafeAreaInsets();
  const held = useAtomValue(kinHomeTabAtom);
  // A place leaves the dock when the session behind it does; fall back rather than show a ghost tab.
  const tab = tabs.includes(held.tab) ? held.tab : "chats";
  const docked = tabs.length > 1;
  const bottomClearance = docked ? kinDockClearance(insets.bottom) : 0;
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
              title="You no longer have access"
              detail="Your team's Kin signed this phone out. Ask them for a new join link to get back in."
              actionLabel="Join with a new link"
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
        <KinDock tabs={tabs} selectedTab={tab} onSelect={select} />
      ) : (
        <KinBadgedDock {...workTarget} tabs={tabs} selectedTab={tab} onSelect={select} />
      )}
    </View>
  );
}

/** The dock, with what needs attention counted on Tasks. */
function KinBadgedDock(props: KinWorkTarget & KinDockProps) {
  const badge = kinAttentionBadge(kinAttentionCount(useKinAttention(props)));
  return (
    <KinDock
      tabs={props.tabs}
      selectedTab={props.selectedTab}
      onSelect={props.onSelect}
      {...(badge === null ? {} : { badges: { tasks: badge } })}
    />
  );
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
            paddingBottom: 16 + props.bottomClearance,
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
