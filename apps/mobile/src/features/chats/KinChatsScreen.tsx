import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_PEOPLE_CHAT } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinNewChatAgent } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { useNavigation } from "@react-navigation/native";
import {
  EnvironmentId,
  type KinAgentId,
  type KinLeadsListResult,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarProps } from "../../components/ui/AppBar.types";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { KIN_ONLY } from "../../lib/kinOnly";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { KinMemoryEntry } from "./KinMemoryScreen";
import { KinTeamEntry } from "./KinTeamScreen";
import { KinWorkEntry } from "./KinWorkScreen";
import { KinAvatar } from "./components/KinAvatar";
import { KinChatRow, KinChatRowSkeletons } from "./components/KinChatRow";
import { KinInboxNotice, KinScreenState, KinStandInNotice } from "./components/KinScreenState";
import { KinWaitingBanner } from "./components/KinWaitingBanner";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  kinChatListAgents,
  kinChatListRowLabel,
  kinChatListRows,
  kinRoomLine,
  type KinChatListRow,
  KIN_CHATS_AGENTS_TITLE,
  KIN_CHATS_EMPTY,
  KIN_CHATS_INTRO,
} from "@t3tools/client-runtime/kin/kinChatListRows";
import {
  formatKinTime,
  kinDirectory,
  kinWaitingBannerView,
  type KinChatRowView,
  type KinDirectory,
  type KinInboxScreenState,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { kinClient } from "./state/kinClient";
import {
  dismissKinIntroAtom,
  kinIntroDismissedAtom,
  kinIntroPersonKey,
} from "./state/kinIntroDismissed";
import { kinJoinedNameAtom } from "./state/kinJoin";
import { useKinOpenAgentChat } from "./state/useKinOpenChat";
import { useKinInbox } from "./state/useKinInbox";
import { useKinProfiles } from "./state/useKinProfiles";
import { kinTabFoot } from "./components/KinTab";

const NO_ENVIRONMENT = EnvironmentId.make("kin:none");

type LeadsResult = AsyncResult.AsyncResult<KinLeadsListResult, unknown> | null;
const noLeadsAtom: Atom.Atom<LeadsResult> = Atom.make<LeadsResult>(null);

/** The Kin list as a page over coding threads: opening and leaving it is the switch between them. */
export function KinChatsScreen() {
  const navigation = useNavigation();
  return <KinChatsList onBack={() => navigation.goBack()} />;
}

/** The chat list under its own bar: a page over coding threads, or the first tab of the Kin home. */
export function KinChatsList({
  empty,
  bottomClearance = 0,
  ...bar
}: Pick<AppBarProps, "onBack" | "actions"> & {
  /** What an empty list says, for a viewer who can't start chats with agents. */
  readonly empty?: { readonly title: string; readonly detail: string };
  readonly bottomClearance?: number;
}) {
  const navigation = useNavigation();
  const { host, state, retry } = useKinInbox();
  const orgId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.orgId ?? null)
      : null;
  const myPersonId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.personId ?? null)
      : null;
  const newLeadAt =
    state._tag === "ready" && orgId !== null ? { environmentId: state.environmentId, orgId } : null;
  const canAddLead = useAtomValue(
    kinClient.leadCreate.permissionAtom(newLeadAt?.environmentId ?? NO_ENVIRONMENT),
  );
  // Who may message whom is the host's rule; it lists them, and a failed read lists none.
  const leadsResult = useAtomValue(
    newLeadAt === null
      ? noLeadsAtom
      : kinClient.leads({
          environmentId: newLeadAt.environmentId,
          input: { orgId: newLeadAt.orgId },
        }),
  );
  const leads = leadsResult === null ? null : Option.getOrNull(AsyncResult.value(leadsResult));
  const agents =
    state._tag === "ready" && leads !== null
      ? kinChatListAgents(state.inbox.value.chats, leads, kinDirectory(host).me)
      : [];
  const openAgentChat = useKinOpenAgentChat();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
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
          {...(empty === undefined ? {} : { empty })}
          agents={agents}
          onOpenAgent={(agentId) => {
            if (newLeadAt === null) return;
            void openAgentChat(newLeadAt.environmentId, newLeadAt.orgId, agentId).then(
              (problem) => {
                if (problem !== null) Dialog.alert(problem);
              },
            );
          }}
          memory={
            <>
              {state._tag === "ready" && orgId !== null && myPersonId !== null ? (
                <KinJoinedName
                  environmentId={state.environmentId}
                  orgId={orgId}
                  personId={myPersonId}
                />
              ) : null}
              {state._tag === "ready" && myPersonId !== null ? (
                <KinWhatKinIs environmentId={state.environmentId} personId={myPersonId} />
              ) : null}
              {
                // Where Kin is the whole app these are Settings pages and a tab, and the list is chats.
                newLeadAt === null || KIN_ONLY ? null : (
                  <>
                    <KinWorkEntry environmentId={newLeadAt.environmentId} orgId={newLeadAt.orgId} />
                    <KinMemoryEntry
                      environmentId={newLeadAt.environmentId}
                      orgId={newLeadAt.orgId}
                    />
                    <KinTeamEntry environmentId={newLeadAt.environmentId} orgId={newLeadAt.orgId} />
                  </>
                )
              }
            </>
          }
          {...(newLeadAt === null || !canAddLead
            ? {}
            : {
                onCreateFirstAgent: () =>
                  navigation.navigate("KinLeadForm", { ...newLeadAt, suggest: "chief" }),
              })}
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

/** Right after joining: the name the team gave this person, to keep or change. */
function KinJoinedName(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: string;
}) {
  const navigation = useNavigation();
  // Only on the computer just joined: elsewhere this person may go by another name.
  const joined = useAtomValue(kinJoinedNameAtom) === props.environmentId;
  const setJoined = useAtomSet(kinJoinedNameAtom);
  const { held } = useKinProfiles(joined ? props.environmentId : null, props.orgId);
  const mine = held?.profiles.find((profile) => profile.personId === props.personId) ?? null;
  if (!joined || mine === null) return null;
  return (
    <View className="px-4 pb-2 pt-2">
      <Notice
        icon="person.crop.circle"
        message={`You joined as ${mine.displayName}. Is that your name?`}
        dismissLabel="Yes"
        onDismiss={() => setJoined(null)}
        action={{
          label: "Change it",
          onPress: () => {
            setJoined(null);
            navigation.navigate("KinProfileEdit", {
              environmentId: props.environmentId,
              orgId: props.orgId,
              personId: mine.personId,
            });
          },
        }}
      />
    </View>
  );
}

/** One line saying what Kin is, on the first Chats screen, until this person dismisses it here. */
function KinWhatKinIs(props: { readonly environmentId: EnvironmentId; readonly personId: string }) {
  const person = kinIntroPersonKey(props.environmentId, props.personId);
  const dismissed = useAtomValue(kinIntroDismissedAtom);
  const dismiss = useAtomSet(dismissKinIntroAtom);
  const [gone, setGone] = useState(false);
  // Hidden until the saved answer loads, so a dismissed line never flashes back.
  if (gone || !AsyncResult.isSuccess(dismissed) || dismissed.value.has(person)) return null;
  return (
    <View className="px-4 pb-2 pt-2">
      <Notice
        icon="info.circle"
        message={KIN_CHATS_INTRO.line}
        dismissLabel={KIN_CHATS_INTRO.dismiss}
        onDismiss={() => {
          setGone(true);
          dismiss(person);
        }}
      />
    </View>
  );
}

/** The list's bar with its "+": a chat with a teammate for everyone; a group or lead by grant. */
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
      menus={[
        {
          title: "New",
          icon: "plus",
          items: [
            {
              id: "person",
              title: KIN_PEOPLE_CHAT.newChat,
              icon: "bubble.left",
              onPress: () => navigation.navigate("KinPeoplePick", target),
            },
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
                    title: "New agent",
                    icon: "robot",
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
      ]}
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
  /** What an empty list says, for a viewer who can't start chats with agents. */
  readonly empty?: { readonly title: string; readonly detail: string };
  /** Room under the last row for a tab dock drawn over the list. */
  readonly bottomClearance?: number;
  readonly onOpenWaiting: () => void;
  readonly onOpenChat: (chatId: KinChatRowView["chatId"]) => void;
  /** A company with no chats yet starts here: its first agent, the Chief of staff suggested. */
  readonly onCreateFirstAgent?: () => void;
  /** Agents the viewer may message and has no chat with yet, under the chats. */
  readonly agents?: ReadonlyArray<KinNewChatAgent>;
  readonly onOpenAgent?: (agentId: KinAgentId) => void;
}) {
  const { state, onOpenChat } = props;
  const view = state._tag === "ready" ? selectKinInboxView(state.inbox.value) : null;
  const banner = view === null ? null : kinWaitingBannerView(view.waiting);
  const agents =
    props.agents === undefined ||
    props.agents.length === 0 ||
    props.onOpenAgent === undefined ? null : (
      <KinAgentsToMessage agents={props.agents} onOpen={props.onOpenAgent} />
    );
  if (state._tag !== "ready" || view === null || view.rows.length === 0) {
    return (
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: 16,
          paddingBottom: kinTabFoot(props.bottomClearance ?? 0),
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
              {props.onCreateFirstAgent === undefined ? (
                <EmptyState
                  title={props.empty?.title ?? KIN_CHATS_EMPTY.title}
                  detail={props.empty?.detail ?? KIN_CHATS_EMPTY.none}
                />
              ) : (
                <EmptyState
                  title={KIN_CHATS_EMPTY.firstAgent}
                  detail={KIN_CHATS_EMPTY.chiefPitch}
                  action={
                    <Button
                      tone="primary"
                      label={KIN_MONEY.createChief}
                      onPress={props.onCreateFirstAgent}
                    />
                  }
                />
              )}
              {agents === null ? null : <View className="-mx-4">{agents}</View>}
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
      contentContainerStyle={{
        paddingTop: 4,
        paddingBottom: kinTabFoot(props.bottomClearance ?? 0),
      }}
      data={rows}
      keyExtractor={(row) => row.chat.chatId}
      estimatedItemSize={64}
      recycleItems
      renderItem={({ item, index }) => (
        <>
          {item.company ? (
            <KinCompanyChatRow
              row={item}
              environmentId={state.environmentId}
              me={props.directory.me}
              onPress={() => onOpenChat(item.chat.chatId)}
            />
          ) : (
            <KinChatRow
              row={item}
              accessibilityLabel={kinChatListRowLabel(item, (date) => formatKinTime(date))}
              onPress={() => onOpenChat(item.chat.chatId)}
            />
          )}
          {index < rows.length - 1 ? <View className="ml-5 h-px bg-border-subtle" /> : null}
        </>
      )}
      ListHeaderComponent={
        <>
          {state._tag === "ready" ? (
            <KinInboxNotice state={state} className="px-4 pb-2 pt-2" />
          ) : (
            <KinStandInNotice className="px-4 pb-2 pt-2" />
          )}
          {banner === null ? null : (
            <>
              <KinWaitingBanner view={banner} onPress={props.onOpenWaiting} />
              <View className="ml-5 h-px bg-border-subtle" />
            </>
          )}
          {props.memory}
        </>
      }
      ListFooterComponent={agents}
    />
  );
}

/** Agents not yet talked to, each with what it is for; a tap opens a chat with it. */
function KinAgentsToMessage(props: {
  readonly agents: ReadonlyArray<KinNewChatAgent>;
  readonly onOpen: (agentId: KinAgentId) => void;
}) {
  return (
    <View className="px-4 pt-4">
      <ListSection title={KIN_CHATS_AGENTS_TITLE}>
        {props.agents.map((agent) => (
          <ListActionRow
            key={agent.agentId}
            label={agent.name}
            {...(agent.intro === null ? {} : { description: agent.intro })}
            accessibilityLabel={`Message ${agent.name}`}
            leading={<KinAvatar avatar={kinAgentAvatar(agent.agentId)} size="small" />}
            onPress={() => props.onOpen(agent.agentId)}
          />
        ))}
      </ListSection>
    </View>
  );
}

/** The company chat's row, with who is in it under its last line. */
function KinCompanyChatRow(props: {
  readonly row: KinChatListRow;
  readonly environmentId: EnvironmentId;
  readonly me: ReadonlySet<string>;
  readonly onPress: () => void;
}) {
  const members = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        kinClient.chatMembers({
          environmentId: props.environmentId,
          input: { chatId: props.row.chat.chatId },
        }),
      ),
    ),
  )?.members;
  const roomLine = members === undefined ? null : kinRoomLine(members, props.me);
  return (
    <KinChatRow
      row={props.row}
      roomLine={roomLine}
      accessibilityLabel={[kinChatListRowLabel(props.row, (date) => formatKinTime(date)), roomLine]
        .filter((part) => part !== null)
        .join(" ")}
      onPress={props.onPress}
    />
  );
}
