import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { kinDockTabs, type KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Platform, View } from "react-native";
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
import { environmentSession } from "../../state/session";
import { SidebarTabBar } from "../layout/workspace/WorkspaceSidebarTabs";
import { useFloatingWorkspaceTabs } from "../layout/workspace/useSystemWorkspaceTabBar";
import { workspaceDockBottomClearance } from "../layout/workspace/workspace-tabs-state";
import { KinChatsList } from "./KinChatsScreen";
import { KinSettings } from "./KinSettings";
import { KinWorkTab } from "./KinWorkScreen";
import { KinScreenState } from "./components/KinScreenState";
import { KinTabContext } from "./components/KinTab";
import { useKinAccessEnded, useKinAppShell } from "./state/kinChatOnly";
import { useKinHost } from "./state/useKinHost";
import { useKinInbox } from "./state/useKinInbox";

/** The native dock's names for the Kin tabs; it draws the icon and label for each. */
const KIN_DOCK_NAMES: Record<KinDockTab, string> = {
  chats: "threads",
  work: "work",
  settings: "settings",
};
const noSessionAtom = Atom.make(null);

/**
 * Kin as the whole app: Chats, Work and Settings as tabs of the dock the coding workspace uses.
 * Work is there for a session the host lets read it, so a teammate gets Chats and Settings.
 */
export function KinHomeScreen() {
  const navigation = useNavigation();
  const host = useKinHost();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const session = useAtomValue(
    host._tag === "host"
      ? environmentSession.sessionStateValueAtom(host.environmentId)
      : noSessionAtom,
  );
  const teammate = useKinAppShell() === "chatOnly";
  const accessEnded = useKinAccessEnded().length > 0;
  const insets = useSafeAreaInsets();
  const compact = useFloatingWorkspaceTabs();
  const [selected, setSelected] = useState<KinDockTab>("chats");
  const tabs = kinDockTabs(session);
  // Work leaves the dock when the session behind it does; fall back rather than show a ghost tab.
  const tab = tabs.includes(selected) ? selected : "chats";
  const orgId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.orgId ?? null)
      : null;
  const workTarget =
    host._tag === "host" && orgId !== null ? { environmentId: host.environmentId, orgId } : null;

  if (KIN_ONLY && !catalog.isReady) return <View className="flex-1 bg-screen" />;
  if (KIN_ONLY && catalog.entries.size === 0) return <KinWelcome />;

  // Android has no dock here yet, so Work and Settings are buttons in the chat list's bar.
  const docked = Platform.OS === "ios";
  const bottomClearance = docked
    ? workspaceDockBottomClearance({ bottomInset: insets.bottom, keyboardHeight: 0 })
    : 0;
  const actions: ReadonlyArray<AppBarAction> | undefined = docked
    ? undefined
    : [
        ...(tabs.includes("work") && workTarget !== null
          ? [
              {
                accessibilityLabel: "Work",
                icon: "checkmark.circle",
                onPress: () => navigation.navigate("KinWork", workTarget),
              } as const,
            ]
          : []),
        {
          accessibilityLabel: "Settings",
          icon: "gearshape",
          onPress: () => navigation.navigate("Settings"),
        } as const,
      ];
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {/* Home's route carries the coding workspace's brand title, and a tab's bar keeps what the
          last tab set (Work's search), so each tab starts from a clean bar. */}
      <NativeStackScreenOptions
        key={tab}
        options={{
          headerTitle: undefined,
          headerSearchBarOptions: undefined,
          unstable_headerToolbarItems: undefined,
        }}
      />
      <KinTabContext value={docked ? { bottomClearance } : null}>
        {tab === "settings" ? (
          <KinSettings />
        ) : tab === "work" ? (
          workTarget === null ? (
            <KinHomeMessage title="Work" bottomClearance={bottomClearance}>
              <KinWorkUnavailable />
            </KinHomeMessage>
          ) : (
            <KinWorkTab {...workTarget} />
          )
        ) : accessEnded ? (
          <KinHomeMessage title="Kin" bottomClearance={bottomClearance} actions={actions}>
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
            actions={actions}
            {...(teammate
              ? {
                  emptyDetail:
                    "When someone on your team starts a chat with you, it shows up here.",
                }
              : {})}
          />
        )}
      </KinTabContext>
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
            onSelect={setSelected}
            nativeTab={(candidate) => KIN_DOCK_NAMES[candidate]}
          />
        </View>
      ) : null}
    </View>
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

/** Work before the Kin behind it has answered: the same reasons the chat list gives. */
function KinWorkUnavailable() {
  const { state, retry } = useKinInbox();
  return (
    <KinScreenState state={state} onRetry={retry}>
      {() => (
        <EmptyState
          variant="plain"
          title="Work isn't ready yet"
          detail="Your Kin hasn't answered. Give it a moment, then open Work again."
        />
      )}
    </KinScreenState>
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
