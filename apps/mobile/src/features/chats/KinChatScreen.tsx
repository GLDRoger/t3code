import { useAtomValue } from "@effect/atom-react";
import {
  type LegendListRef,
  type OnViewableItemsChangedInfo,
  type ViewabilityConfigCallbackPairs,
} from "@legendapp/list/react-native";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  EnvironmentId,
  KinChatId,
  type KinChatHistoryInput,
  type KinChatHistoryResult,
  type KinChatMember,
  type KinChatMembersResult,
  type KinChatSummary,
  type KinLeadsListResult,
  type KinMessage,
  type KinReaction,
  type KinReactionEmoji,
  type KinWidget,
  type KinPresence,
  type KinWakeupId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/reactivity";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { use, useEffect, useRef, useState, type ComponentPropsWithRef } from "react";
import {
  AppState,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import Animated, { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { LoadingStrip } from "../../components/ui/LoadingStrip";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useBarOverlap, useContentTopInset } from "../../components/ui/useBarInset";
import { useReduceMotionEnabled } from "../../lib/appState";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { HeaderItemsWidthContext } from "../../native/header-items-width";
import { useNativeFontScale } from "../settings/appearance/useScaledTextRole";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import type { ComposerEditorHandle } from "../../native/T3ComposerEditor.types";
import { appAtomRegistry } from "../../state/atom-registry";
import { AppText } from "../../components/ui/AppText";
import { setComposerDraftText } from "../../state/use-composer-drafts";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useResolveClassNames } from "uniwind";
import type { NativeMarkdownTextStyle } from "../../native/SelectableMarkdownText";
import {
  editKinOutboxEntry,
  KIN_COMPOSER_COLLAPSED_HEIGHT,
  KIN_COMPOSER_GUTTER,
  KinComposer,
  kinDraftKey,
} from "./components/KinComposer";
import { KinFoldLine } from "./components/KinFoldLine";
import { KinMessageSheet } from "./components/KinMessageSheet";
import { KinChatTitle } from "./components/KinChatTitle";
import { KinOfflineState, KinStaleNoticeView } from "./components/KinScreenState";
import { KinIntro } from "./components/KinIntro";
import {
  KinPresenceLine,
  useKinPresenceNow,
  type KinStopState,
} from "./components/KinPresenceLine";
import {
  KinDayLine,
  KinDraftBubble,
  KinMessageBubble,
  KinPendingBubble,
  KinSystemLine,
} from "./components/KinMessageBubble";
import {
  buildKinFeedRows,
  initialKinPaging,
  kinActivePaging,
  kinChatScreenState,
  kinChatStatusLine,
  kinEarlierPage,
  kinFeedViewer,
  kinLinkToOpen,
  kinMarkReadRearms,
  kinRowSeq,
  kinSeqToMarkRead,
  kinUnseenCount,
  latestKinSeq,
  mergeKinFeed,
  type KinChatScreenState,
  type KinFeedRow,
  type KinFeedViewer,
  type KinPaging,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinFeedMessages } from "@t3tools/client-runtime/kin/kinCardPresentation";
import { useLocalDayStartMs } from "./state/useLocalDayStartMs";
import { kinClient, type KinSynced } from "./state/kinClient";
import { splitKinOutbox, type KinOutboxEntry } from "@t3tools/client-runtime/kin/kinOutbox";
import { deliverKinOutbox, kinOutbox } from "./state/kinOutboxDelivery";
import { kinIntroVisible } from "@t3tools/client-runtime/kin/kinIntro";
import {
  initialKinFeedFollow,
  kinFollowsEnd,
  resolveKinFeedFollow,
  type KinFeedFollowEvent,
} from "@t3tools/client-runtime/kin/kinFeedFollow";
import {
  applyKinChatEvent,
  applyKinChatHistory,
  emptyKinChat,
  KIN_CACHED_MESSAGE_LIMIT,
  type KinChatState,
  type KinInboxState,
} from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinPresenceLine, kinPresenceNeedsClock } from "@t3tools/client-runtime/kin/kinLive";
import {
  kinChatMuted,
  kinChatTitle,
  kinDirectAgentName,
  kinAgentAvatar,
  kinAvatarView,
  type KinAvatarView,
  kinOwnedLeadAgentId,
  kinStaleNotice,
} from "@t3tools/client-runtime/kin/kinScreenState";
import {
  kinChatReadOnly,
  kinChatReadOnlyLine,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { useKinHostAt } from "./state/useKinHost";
import { useKinReconnect } from "./state/useKinReconnect";
import {
  kinMemberNames,
  kinMentionCandidates,
  kinMentionsIn,
  type KinMentionCandidate,
} from "@t3tools/client-runtime/kin/kinGroups";
import {
  kinReactionChips,
  kinReactionToggle,
  kinViewerMemberId,
} from "@t3tools/client-runtime/kin/kinReactions";
import { KinBadgeSync } from "./notifications/KinBadgeSync";
import { KinChatPushWatch } from "./notifications/KinChatPushWatch";

type KinChatParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly chatId: string;
};

type KinFixtures = typeof import("@t3tools/client-runtime/kin/kinChatFixtures");

export function KinChatScreen({ route }: StaticScreenProps<KinChatParams>) {
  // `KIN_FIXTURE_CHAT_ID`; required inside the `__DEV__` branch so release builds drop it.
  if (__DEV__ && route.params.chatId === "dev-fixture") {
    return (
      <KinFixtureChat
        fixtures={require("@t3tools/client-runtime/kin/kinChatFixtures") as KinFixtures}
      />
    );
  }
  const environmentId = decodeEnvironmentId(route.params.environmentId);
  if (Option.isNone(environmentId)) {
    return (
      <KinChatPage
        orgId={route.params.orgId}
        chatId={route.params.chatId as KinChatId}
        title="Chat"
        agentName={null}
        unread={null}
        markRead={null}
        state={{ _tag: "noHost" }}
        viewer={{ personId: null, agentNames: new Map() }}
        onRetry={() => {}}
        readHistory={null}
      />
    );
  }
  return (
    <KinLiveChat
      environmentId={environmentId.value}
      orgId={route.params.orgId}
      chatId={route.params.chatId}
    />
  );
}

type ChatResult = AsyncResult.AsyncResult<KinSynced<KinChatState>, unknown> | null;
type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;
const noChatAtom: Atom.Atom<ChatResult> = Atom.make<ChatResult>(null);
const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);
type LeadsResult = AsyncResult.AsyncResult<KinLeadsListResult, unknown> | null;
const noLeadsAtom: Atom.Atom<LeadsResult> = Atom.make<LeadsResult>(null);
type MembersResult = AsyncResult.AsyncResult<KinChatMembersResult, unknown> | null;
const noMembersAtom: Atom.Atom<MembersResult> = Atom.make<MembersResult>(null);

const decodeChatId = Schema.decodeUnknownOption(KinChatId);
/** Read at render: a mute only ends when its time passes, and a re-render reads it again. */
const mutedNow = (chat: KinChatSummary, personId: string | null) =>
  personId !== null && kinChatMuted(chat, new Set([personId]), Date.now());
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

function KinLiveChat(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly chatId: string;
}) {
  // The route's host, not the saved one: every Kin host uses the same org id.
  const host = useKinHostAt(props.environmentId);
  const chatId = Option.getOrNull(decodeChatId(props.chatId));
  const environmentId = host._tag === "host" ? host.environmentId : null;
  const chatAtom: Atom.Atom<ChatResult> =
    environmentId === null || chatId === null
      ? noChatAtom
      : kinClient.chat({ environmentId, input: { chatId } });
  const inboxAtom: Atom.Atom<InboxResult> =
    environmentId === null ? noInboxAtom : kinClient.inbox({ environmentId, input: {} });
  const chatResult = useAtomValue(chatAtom);
  const inbox = useAtomValue(inboxAtom);
  const state: KinChatScreenState =
    chatId === null ? { _tag: "gone", reason: "not_found" } : kinChatScreenState(host, chatResult);
  const viewer = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    props.orgId,
  );
  const summary =
    inbox?._tag === "Success"
      ? inbox.value.value.chats.find((chat) => chat.chatId === chatId)
      : undefined;
  // The owner's own lead in their direct chat: the only one they can stop.
  const ownedAgentId = summary === undefined ? null : kinOwnedLeadAgentId(summary, viewer.personId);
  // A direct chat's lead has details to open: the viewer's own, or one they were let message.
  const leads = useAtomValue(
    environmentId === null || summary === undefined || summary.kind !== "direct"
      ? noLeadsAtom
      : kinClient.leads({ environmentId, input: { orgId: summary.orgId } }),
  );
  // A group's row carries only the viewer's own member; who else is in it is read by name.
  const group = summary !== undefined && summary.kind !== "direct";
  const groupResult = useAtomValue(
    environmentId === null || chatId === null || !group
      ? noMembersAtom
      : kinClient.chatMembers({ environmentId, input: { chatId } }),
  );
  const groupMembers =
    groupResult === null
      ? null
      : (Option.getOrNull(AsyncResult.value(groupResult))?.members ?? null);
  const charter =
    leads !== null && AsyncResult.isSuccess(leads)
      ? (leads.value.leads.find((lead) => lead.agentId === ownedAgentId)?.charter ?? null)
      : null;
  const contact =
    leads !== null && AsyncResult.isSuccess(leads) && ownedAgentId === null
      ? (leads.value.contacts?.find((held) => held.chatId === chatId) ?? null)
      : null;
  const readOnly = kinChatReadOnly(summary, viewer.personId);
  const navigation = useNavigation();
  const canInterrupt = useAtomValue(kinClient.leadInterrupt.permissionAtom(props.environmentId));
  const canMute = useAtomValue(kinClient.mute.permissionAtom(props.environmentId));
  const runMute = useAtomCommand(kinClient.mute, "Muting this chat");
  const muted = summary === undefined ? false : mutedNow(summary, viewer.personId);

  const retry = () => {
    if (environmentId === null) return;
    if (state._tag === "error" && state.retry === "orgs") {
      appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
    } else if (state._tag === "error" || (state._tag === "ready" && state.error !== null)) {
      appAtomRegistry.refresh(chatAtom);
    }
  };

  return (
    <>
      <KinChatPushWatch environmentId={props.environmentId} chatId={props.chatId} />
      {/* Only a live inbox: a saved one would put an old count back on the icon. */}
      <KinBadgeSync
        inbox={inbox?._tag === "Success" && inbox.value.live ? inbox.value.value : null}
      />
      <KinChatPage
        environmentId={props.environmentId}
        orgId={props.orgId}
        chatId={chatId ?? (props.chatId as KinChatId)}
        title={summary === undefined ? "Chat" : kinChatTitle(summary, viewer.agentNames)}
        avatar={
          summary === undefined
            ? undefined
            : kinAvatarView(
                summary,
                summary.members.find(
                  (member) => member.leftAt === null && member.principal._tag === "agent",
                ) ?? null,
              )
        }
        agentName={summary === undefined ? null : kinDirectAgentName(summary, viewer.agentNames)}
        unread={summary?.unread ?? null}
        mute={
          environmentId === null || chatId === null || summary === undefined || !canMute
            ? null
            : {
                muted,
                toggle: () => {
                  void runMute({ environmentId, input: { chatId, muted: !muted } });
                },
              }
        }
        stopLead={
          environmentId === null || summary === undefined || ownedAgentId === null || !canInterrupt
            ? null
            : (wakeupId) =>
                kinClient.leadInterrupt
                  .run(appAtomRegistry, {
                    environmentId,
                    input: { orgId: summary.orgId, wakeupId: wakeupId as KinWakeupId },
                  })
                  .then((result) => result._tag === "Success")
        }
        markRead={
          environmentId === null || chatId === null
            ? null
            : (seq) =>
                kinClient.markRead
                  .run(appAtomRegistry, { environmentId, input: { chatId, seq } })
                  .then((result) => result._tag === "Success")
        }
        state={state}
        viewer={group ? { ...viewer, memberNames: kinMemberNames(groupMembers) } : viewer}
        members={groupMembers ?? summary?.members ?? []}
        mentionable={group ? kinMentionCandidates(groupMembers) : undefined}
        group={
          environmentId === null || summary === undefined || !group
            ? null
            : () =>
                navigation.navigate("KinGroup", {
                  environmentId,
                  orgId: summary.orgId,
                  chatId: summary.chatId,
                })
        }
        direct={summary?.kind === "direct"}
        ownsLead={ownedAgentId !== null}
        lead={
          environmentId === null || summary === undefined
            ? null
            : ownedAgentId !== null
              ? {
                  charter,
                  open: () =>
                    navigation.navigate("KinLead", {
                      environmentId,
                      orgId: summary.orgId,
                      agentId: ownedAgentId,
                    }),
                }
              : contact !== null
                ? {
                    charter: null,
                    open: () =>
                      navigation.navigate("KinLead", {
                        environmentId,
                        orgId: summary.orgId,
                        agentId: contact.agentId,
                      }),
                  }
                : null
        }
        about={contact === null || contact.intro.trim() === "" ? null : contact.intro.trim()}
        readOnly={readOnly}
        onRetry={retry}
        readHistory={
          state._tag === "ready" && state.connected
            ? (input) => kinClient.readHistoryPage(state.environmentId, input)
            : null
        }
      />
    </>
  );
}

// Mirrors the host's reactable cards; the host still refuses the rest.
const REACTABLE_WIDGETS = new Set(["choice", "task", "routine"]);

let fixtureMessages: ReadonlyArray<KinMessage> | null = null;
const readFixtureMessages = (fixtures: KinFixtures) =>
  (fixtureMessages ??= fixtures.makeKinFixtureMessages(500));

/**
 * Dev only: 500 local messages, the latest 50 live, older ones paged in by "Load earlier". On
 * open, a scripted lead turn streams in: presence, a draft reply, its message, then a stall.
 */
function KinFixtureChat({ fixtures }: { readonly fixtures: KinFixtures }) {
  const getFixtureMessages = () => readFixtureMessages(fixtures);
  const [value, setValue] = useState<KinChatState>(() => ({
    ...emptyKinChat,
    messages: getFixtureMessages().slice(-KIN_CACHED_MESSAGE_LIMIT),
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- plays the fixture's scripted stream on timers, as a host would
  useEffect(() => {
    const script = fixtures.kinFixtureReplyScript(latestKinSeq(getFixtureMessages()), Date.now());
    const timers = script.map(({ atMs, event }) =>
      setTimeout(() => setValue((current) => applyKinChatEvent(current, event)), atMs),
    );
    return () => timers.forEach(clearTimeout);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- plays once per open.
  }, []);
  const chat: KinSynced<KinChatState> = { value, live: true, savedAt: null };
  return (
    <KinChatPage
      orgId="dev"
      chatId={fixtures.KIN_FIXTURE_CHAT_ID}
      title="Tech lead"
      avatar={kinAgentAvatar(fixtures.KIN_FIXTURE_AGENT)}
      agentName="Tech lead"
      unread={null}
      markRead={null}
      state={{
        _tag: "ready",
        environmentId: "dev-fixture" as EnvironmentId,
        connected: true,
        chat,
        error: null,
      }}
      viewer={{
        personId: fixtures.KIN_FIXTURE_OWNER,
        agentNames: new Map([[fixtures.KIN_FIXTURE_AGENT, "Tech lead"]]),
      }}
      onRetry={() => {}}
      stopLead={() => {
        setValue((current) =>
          applyKinChatEvent(current, {
            _tag: "presence",
            agentId: fixtures.KIN_FIXTURE_AGENT,
            presence: null,
          }),
        );
        return Promise.resolve(true);
      }}
      readHistory={(input) =>
        Promise.resolve(Exit.succeed(fixtures.readKinFixtureHistory(getFixtureMessages(), input)))
      }
    />
  );
}

type ReadHistory = (
  input: KinChatHistoryInput,
) => Promise<Exit.Exit<KinChatHistoryResult, unknown>>;

type MarkRead = (seq: number) => Promise<boolean>;
type StopLead = (wakeupId: string) => Promise<boolean>;

/** The lead's presence while the feed is live; a stale one would claim work that may be over. */
const livePresence = (state: KinChatScreenState): KinPresence | undefined =>
  state._tag === "ready" && state.connected && state.chat.live
    ? state.chat.value.presence.at(-1)
    : undefined;

// The glass bar's title size (GLASS_HEADER_OPTIONS) and UIKit's subtitle size, for the bars
// that keep UIKit's own title. The bar is one fixed height, so it stops growing at 1.5x.
const KIN_BAR_TITLE_SIZE = 18;
const KIN_BAR_SUBTITLE_SIZE = 12;
const KIN_BAR_MAX_FONT_SCALE = 1.5;

/**
 * The chat's bar, as on a thread: Back and who the chat is with. The avatar and name open the
 * chat's details; presence sits in the status row above the composer.
 */
function KinChatAppBar(props: {
  readonly title: string;
  readonly avatar: KinAvatarView;
  readonly presence: KinPresence | undefined;
  readonly tasks: string | null;
  readonly onBack: () => void;
  readonly details: KinChatDetails | null;
}) {
  const ios = Platform.OS === "ios";
  const now = useKinPresenceNow(!ios && kinPresenceNeedsClock(props.presence));
  const subtitle = ios ? null : (kinPresenceLine(props.presence, now)?.subtitle ?? props.tasks);
  // The native bar sets fixed font sizes, so it follows Dynamic Type only through these.
  const scale = useNativeFontScale(KIN_BAR_MAX_FONT_SCALE);
  const { title, avatar, tasks, details } = props;
  const renderTitle = () => (
    <KinChatHeaderTitle title={title} avatar={avatar} detail={tasks} details={details} />
  );
  return (
    <>
      <AppBar
        title={title}
        subtitle={subtitle}
        onBack={props.onBack}
        titleContent={
          <KinChatTitle
            title={title}
            avatar={avatar}
            detail={null}
            onPress={details?.open}
            accessibilityHint={details?.hint}
          />
        }
      />
      {/* Always set, so going back to the default size resets the bar. */}
      <NativeStackScreenOptions
        optionsVersion={[title, avatar.seed, avatar.kind, tasks, details?.hint]}
        options={{
          headerTitleStyle: { fontSize: KIN_BAR_TITLE_SIZE * scale, fontWeight: "800" },
          headerSubtitleStyle: { fontSize: KIN_BAR_SUBTITLE_SIZE * scale },
          headerTitle: ios ? renderTitle : undefined,
        }}
      />
    </>
  );
}

/** What a tap on the chat's avatar or name opens. */
type KinChatDetails = { readonly open: () => void; readonly hint: string };

function KinChatHeaderTitle(props: {
  readonly title: string;
  readonly avatar: KinAvatarView;
  readonly detail: string | null;
  readonly details: KinChatDetails | null;
}) {
  const { width } = useWindowDimensions();
  const maxWidth = Math.max(120, width - (use(HeaderItemsWidthContext) ?? 160));
  return (
    <KinChatTitle
      title={props.title}
      avatar={props.avatar}
      detail={props.detail}
      maxWidth={maxWidth}
      onPress={props.details?.open}
      accessibilityHint={props.details?.hint}
    />
  );
}

function KinChatPage(props: {
  /** The route's host, for Reconnect while offline; unset in the dev fixture. */
  readonly environmentId?: EnvironmentId;
  readonly orgId: string;
  readonly chatId: KinChatId;
  readonly title: string;
  /** Who the chat is with, for the title pill; unset until the inbox loads. */
  readonly avatar?: KinAvatarView;
  /** The agent a direct chat is with, for the empty chat's copy; null when unknown. */
  readonly agentName: string | null;
  /** The inbox's unread count for this chat; null until the inbox loads. */
  readonly unread: number | null;
  /** Null where nothing can be marked, such as the dev fixture. */
  readonly markRead: MarkRead | null;
  /** Interrupts the lead's current wake-up; null unless the viewer owns it and may stop it. */
  readonly stopLead?: StopLead | null;
  /** The viewer's mute for this chat's notifications; null until it can be set. */
  readonly mute?: { readonly muted: boolean; readonly toggle: () => void } | null;
  readonly state: KinChatScreenState;
  readonly viewer: KinFeedViewer;
  readonly onRetry: () => void;
  /** Null while older pages can't be read, such as offline. */
  readonly readHistory: ReadHistory | null;
  /** The chat's members from the inbox, for reactions; empty until it loads. */
  readonly members?: ReadonlyArray<KinChatMember>;
  readonly direct?: boolean;
  /** The viewer owns this direct chat's lead, so a first run shows the intro. */
  readonly ownsLead?: boolean;
  /** This direct chat's lead, for its details and the owner's intro; null otherwise. */
  readonly lead?: { readonly charter: string | null; readonly open: () => void } | null;
  /** What the owner of someone else's lead wrote for the people let message it. */
  readonly about?: string | null;
  /** The viewer may read this chat and no longer write in it. */
  readonly readOnly?: boolean;
  /** Opens a group's details; null for any other chat. */
  readonly group?: (() => void) | null;
  /** A group's leads, which the composer offers on `@`. */
  readonly mentionable?: ReadonlyArray<KinMentionCandidate>;
}) {
  const navigation = useNavigation();
  const lead = props.lead ?? null;
  const { mute } = props;
  // A lead's details hold its mute; a chat without them asks about the mute directly.
  const details: KinChatDetails | null =
    lead !== null
      ? { open: lead.open, hint: "Opens this lead's details" }
      : props.group != null
        ? { open: props.group, hint: "Opens this group's details" }
        : mute == null
          ? null
          : {
              hint: mute.muted ? "Offers to unmute this chat" : "Offers to mute this chat",
              open: () =>
                Dialog.confirm({
                  title: props.title,
                  message: mute.muted
                    ? "Notifications from this chat are muted."
                    : "You get a notification for each new message in this chat.",
                  confirmText: mute.muted ? "Unmute notifications" : "Mute notifications",
                  onConfirm: mute.toggle,
                }),
            };
  const topInset = useContentTopInset();
  const { state } = props;
  const tasks = state._tag === "ready" ? kinChatStatusLine(state.chat.value.widgets) : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <KinChatAppBar
        title={props.title}
        avatar={props.avatar ?? { kind: "agent", seed: `chat:${props.chatId}` }}
        presence={livePresence(state)}
        tasks={tasks}
        onBack={() => navigation.goBack()}
        details={details}
      />
      <ScreenContent surface="screen">
        {state._tag === "ready" ? (
          <KinChatFeed
            // Paging, folds and follow belong to one chat.
            key={`${state.environmentId}:${props.chatId}`}
            orgId={props.orgId}
            title={props.title}
            environmentId={state.environmentId}
            chatId={props.chatId}
            agentName={props.agentName}
            charter={lead?.charter ?? null}
            chat={state.chat}
            connected={state.connected}
            error={state.error}
            onRetry={props.onRetry}
            viewer={props.viewer}
            readHistory={props.readHistory}
            unread={props.unread}
            markRead={props.markRead}
            presence={livePresence(state)}
            stopLead={props.stopLead ?? null}
            members={props.members ?? []}
            direct={props.direct ?? false}
            ownsLead={props.ownsLead ?? false}
            about={props.about ?? null}
            readOnly={props.readOnly ?? false}
            mentionable={props.mentionable}
          />
        ) : (
          <KinChatStateView
            state={state}
            environmentId={props.environmentId ?? null}
            onRetry={props.onRetry}
          />
        )}
      </ScreenContent>
      {state._tag === "loading" ? (
        <View pointerEvents="none" className="absolute inset-x-0" style={{ top: topInset }}>
          <LoadingStrip />
        </View>
      ) : null}
    </View>
  );
}

function KinChatStateView(props: {
  readonly state: Exclude<KinChatScreenState, { readonly _tag: "ready" }>;
  readonly environmentId: EnvironmentId | null;
  readonly onRetry: () => void;
}) {
  const navigation = useNavigation();
  const { state } = props;
  const body = (() => {
    switch (state._tag) {
      case "loading":
        return null;
      case "offline":
        return <KinOfflineState environmentId={props.environmentId} resource="This chat loads" />;
      case "noHost":
        return (
          <EmptyState
            variant="plain"
            title="No server with Kin yet"
            detail="Connect this phone to a T3 Code server that has Kin turned on."
            actionLabel="Open environments"
            onAction={() => navigation.navigate("SettingsEnvironments")}
          />
        );
      case "unpaired":
        return (
          <EmptyState
            variant="plain"
            title="This phone isn't paired with the server anymore"
            detail="Pair it again to open this chat."
            actionLabel="Open environments"
            onAction={() => navigation.navigate("SettingsEnvironments")}
          />
        );
      case "unauthorized":
        return (
          <EmptyState
            variant="plain"
            title="This phone can't read Kin chats"
            detail="Pair it again with the computer that runs T3 Code."
          />
        );
      case "noIdentity":
        return (
          <EmptyState
            variant="plain"
            title="You're not in Kin on this server yet"
            detail="Ask whoever runs it to add you, then come back."
          />
        );
      case "gone":
        return (
          <EmptyState
            variant="plain"
            title={
              state.reason === "left"
                ? "You were removed from this chat"
                : state.reason === "disabled"
                  ? "Kin is turned off on this server"
                  : "This chat isn't available"
            }
            detail={
              state.reason === "left"
                ? "Ask the chat's owner to add you back."
                : state.reason === "disabled"
                  ? "Ask whoever runs Kin here to turn it back on, then come back."
                  : state.reason === "not_found" || state.reason === "not_allowed"
                    ? "It may have been removed, or you're no longer a member."
                    : "Kin couldn't open this chat. Go back to your chats and try again."
            }
            actionLabel="Back to chats"
            onAction={() => navigation.dispatch(StackActions.popTo("KinChats"))}
          />
        );
      case "error":
        return (
          <View className="gap-3">
            <ErrorBanner message={state.message} />
            <View className="self-start">
              <Button tone="secondary" size="compact" label="Retry" onPress={props.onRetry} />
            </View>
          </View>
        );
    }
  })();
  return <View className="flex-1 justify-center p-4">{body}</View>;
}

const offlineTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
// A row counts as seen once half of it shows, or once it fills half the screen: a message taller
// than two screens never shows half of itself. A row peeking under the edge still lights the pill.
const SEEN_ROW_CONFIGS = [
  { id: "kin-seen-row", itemVisiblePercentThreshold: 50 },
  { id: "kin-seen-area", viewAreaCoveragePercentThreshold: 50 },
] as const;

type KinChatRow =
  | KinFeedRow
  | {
      readonly type: "pending";
      readonly key: string;
      readonly entry: KinOutboxEntry;
      readonly continues: boolean;
    };

function KinChatFeed(props: {
  readonly orgId: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly chatId: KinChatId;
  readonly agentName: string | null;
  /** What the viewer made their lead for, shown on the first-run intro. */
  readonly charter: string | null;
  readonly chat: KinSynced<KinChatState>;
  readonly connected: boolean;
  /** The stream failed after the feed loaded. */
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly viewer: KinFeedViewer;
  readonly readHistory: ReadHistory | null;
  readonly unread: number | null;
  readonly markRead: MarkRead | null;
  readonly presence: KinPresence | undefined;
  readonly stopLead: StopLead | null;
  readonly members: ReadonlyArray<KinChatMember>;
  readonly direct: boolean;
  readonly ownsLead: boolean;
  readonly about: string | null;
  readonly readOnly: boolean;
  readonly mentionable?: ReadonlyArray<KinMentionCandidate>;
}) {
  const listRef = useRef<LegendListRef>(null);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const markedSeq = useRef(0);
  const attemptedSeq = useRef(0);
  const marking = useRef(false);
  const focused = useIsFocused();
  const dayStartMs = useLocalDayStartMs();
  const lastRequest = useRef(0);
  const reduceMotion = useReduceMotionEnabled();
  const barOverlap = useBarOverlap();
  const markdownStyle = useMarkdownPreviewStyles().nativeTextStyle;
  const ownMarkdownStyle = useOwnBubbleMarkdownStyle(markdownStyle);
  // Each open gets its own sheet, so a dismissal the list never heard of can't block the next.
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [actions, setActions] = useState<{ readonly messageId: string; readonly open: number }>({
    messageId: "",
    open: 0,
  });
  const openActions = (messageId: string) =>
    setActions((current) => ({ messageId, open: current.open + 1 }));
  const actionsFor = actions.messageId === "" ? null : actions.messageId;
  const safeBottom = useSafeAreaInsets().bottom;
  // Clears the home indicator; the keyboard offset gives that space back while the keyboard is up.
  const composerInset = Math.max(safeBottom, KIN_COMPOSER_GUTTER);
  const keyboardOffset = composerInset - KIN_COMPOSER_GUTTER;
  // As in the thread feed: the composer overlays the feed, whose end inset tracks the composer's
  // measured height, safe area included, and the keyboard.
  const contentInsetEndAdjustment = useSharedValue(KIN_COMPOSER_COLLAPSED_HEIGHT + composerInset);
  const [composerHeight, setComposerHeight] = useState(
    KIN_COMPOSER_COLLAPSED_HEIGHT + composerInset,
  );
  const [listHeight, setListHeight] = useState(0);
  const onComposerLayout = (event: LayoutChangeEvent) => {
    contentInsetEndAdjustment.set(event.nativeEvent.layout.height);
    setComposerHeight(event.nativeEvent.layout.height);
  };
  // Android can lose IME hide callbacks on backgrounding, as in the thread feed: hold the composer
  // down on resume until the keyboard reports again or the composer is focused.
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const [keyboardSuspect, setKeyboardSuspect] = useState(false);
  const composerFocused = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState on Android to mark keyboard state suspect when the app resumes
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setKeyboardSuspect(!composerFocused.current);
    });
    return () => subscription.remove();
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the suspect flag whenever the native keyboard reports a visibility or height change
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Any native keyboard report clears the suspect flag set when the app resumed.
    setKeyboardSuspect(false);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Any keyboard visibility or height report clears the suspect flag set when the app resumed.
  }, [keyboardVisible, keyboardHeight]);
  const onComposerFocus = (focused: boolean) => {
    composerFocused.current = focused;
    if (focused) setKeyboardSuspect(false);
  };
  const openLink = useOpenPullRequest();
  const [heldPaging, setPaging] = useState<KinPaging>(initialKinPaging);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(new Set());
  const [follow, setFollow] = useState(() =>
    initialKinFeedFollow(latestKinSeq(props.chat.value.messages)),
  );

  const live = props.chat.value;
  const paging = kinActivePaging(heldPaging, live);
  const outbox = useAtomValue(kinOutbox.chatAtom(props.environmentId, props.chatId));
  const streamed = mergeKinFeed(live, paging.earlier);
  const { acked, pending, echoed } = splitKinOutbox(outbox, streamed.messages);
  const echoedKey = echoed.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frees outbox entries once the stream carries their message
  useEffect(() => {
    if (echoedKey !== "") kinOutbox.forgetEchoed(new Set(echoedKey.split("\n")));
  }, [echoedKey]);
  const { messages } = mergeKinFeed(streamed, { ...emptyKinChat, messages: acked });
  const widgets = new Map(streamed.widgets.map((widget) => [widget.widgetId, widget]));
  const canReactHere = useAtomValue(kinClient.react.permissionAtom(props.environmentId));
  const react = useAtomCommand(kinClient.react, "react");
  const viewerMemberId = kinViewerMemberId(props.members, props.viewer.personId);
  const canReact =
    canReactHere &&
    viewerMemberId !== null &&
    props.members.some((member) => member.memberId === viewerMemberId && member.role !== "guest");
  const reactorName = (memberId: string) => {
    const member = props.members.find((candidate) => candidate.memberId === memberId);
    if (member === undefined) return null;
    return member.principal._tag === "agent"
      ? (props.viewer.agentNames.get(member.principal.agentId) ?? "Lead")
      : (props.viewer.memberNames?.get(memberId) ?? (member.role === "owner" ? "Owner" : "Member"));
  };
  const feedRows = buildKinFeedRows(
    kinFeedMessages(messages, widgets),
    props.viewer,
    expandedRuns,
    new Date(dayStartMs),
    live.drafts,
  );
  const [stop, setStop] = useState<{ readonly wakeupId: string; readonly state: KinStopState }>({
    wakeupId: "",
    state: "idle",
  });
  const { presence, stopLead } = props;
  const presenceAvatar = presence === undefined ? null : kinAgentAvatar(presence.agentId);
  const wakeupId = presence?.wakeupId ?? null;
  // A new wake-up starts with a fresh Stop.
  const stopState = wakeupId !== null && stop.wakeupId === wakeupId ? stop.state : "idle";
  const onStop =
    stopLead === null || wakeupId === null
      ? null
      : () => {
          setStop({ wakeupId, state: "stopping" });
          // Stopping holds until the wake-up's presence clears.
          void stopLead(wakeupId).then((sent) =>
            setStop((current) =>
              current.wakeupId === wakeupId && !sent ? { wakeupId, state: "failed" } : current,
            ),
          );
        };
  const lastFeedRow = feedRows.at(-1);
  const endsOnOwn = lastFeedRow?.type === "message" && lastFeedRow.own;
  const rows: ReadonlyArray<KinChatRow> =
    pending.length === 0
      ? feedRows
      : [
          ...feedRows,
          ...pending.map((entry, index) => ({
            type: "pending" as const,
            key: `pending:${entry.clientMessageId}`,
            entry,
            continues: index > 0 || endsOnOwn,
          })),
        ];
  // LegendList grows an empty list to its frame, under both insets, which hid the intro under the
  // composer; the visible height ends it above the composer instead.
  const emptyMinHeight =
    rows.length === 0 && listHeight > 0
      ? Math.max(0, listHeight - barOverlap - composerHeight)
      : null;
  const followsEnd = kinFollowsEnd(follow);
  const unseen = followsEnd ? 0 : kinUnseenCount(messages, follow.seenSeq, props.viewer.personId);
  const loading = paging.request !== null;
  const earlierPage = kinEarlierPage(props.chatId, messages, paging.exhausted);
  const canLoadEarlier = props.readHistory !== null && earlierPage !== null;
  const latestSeq = latestKinSeq(messages);
  const showIntro = kinIntroVisible({
    ownsLead: props.ownsLead,
    agentName: props.agentName,
    viewerPersonId: props.viewer.personId,
    messages,
    pendingCount: pending.length,
    historyIncomplete: earlierPage !== null || live.needsHistoryReload,
  });
  const { connected, markRead, unread } = props;
  const seesEnd = followsEnd && focused && connected && props.chat.live;
  const reading = useRef({ markRead, seesEnd, latestSeq, unread, connected, focused });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host what the reader has seen, one call in flight at a time
  useEffect(() => {
    const next = { markRead, seesEnd, latestSeq, unread, connected, focused };
    if (kinMarkReadRearms(reading.current, next)) attemptedSeq.current = markedSeq.current;
    reading.current = next;
    // Re-reads the latest inputs when a call settles, so a message that arrived meanwhile is marked.
    const send = () => {
      const current = reading.current;
      if (current.markRead === null || marking.current) return;
      const seq = kinSeqToMarkRead({
        ...current,
        markedSeq: markedSeq.current,
        attemptedSeq: attemptedSeq.current,
      });
      if (seq === null) return;
      marking.current = true;
      attemptedSeq.current = seq;
      void current.markRead(seq).then((marked) => {
        marking.current = false;
        if (marked) markedSeq.current = Math.max(markedSeq.current, seq);
        send();
      });
    };
    send();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- lists every value the effect reads; the rest are refs. The rule started flagging it once the feed grew.
  }, [markRead, seesEnd, latestSeq, unread, connected, focused]);

  const transition = (event: KinFeedFollowEvent) =>
    setFollow((current) => resolveKinFeedFollow(current, event));
  const reconnect = useKinReconnect(props.environmentId);
  const notice = kinStaleNotice(
    { connected: props.connected, live: props.chat.live, savedAt: props.chat.savedAt },
    reconnect.status,
    (date) => offlineTime.format(date),
  );

  const loadEarlier = () => {
    const read = props.readHistory;
    if (read === null || earlierPage === null || loading) return;
    const request = ++lastRequest.current;
    // Starts from the paging that fits the stream, so pages dropped by a reset stay dropped.
    setPaging({
      ...paging,
      anchorSeq: paging.anchorSeq ?? live.messages[0]?.seq ?? null,
      request,
      error: null,
    });
    transition({ type: "page-start" });
    void read(earlierPage).then((exit) => {
      // A newer request or a remount owns the state now.
      if (lastRequest.current !== request) return;
      setPaging((current) =>
        Exit.isSuccess(exit)
          ? {
              ...current,
              earlier: applyKinChatHistory(current.earlier, exit.value),
              exhausted: !exit.value.hasMore,
              request: null,
            }
          : { ...current, request: null, error: "Couldn't load earlier messages." },
      );
      transition({
        type: "page-settled",
        added: Exit.isSuccess(exit) && exit.value.messages.length > 0,
      });
    });
  };

  const checkEnd = () => {
    const isAtEnd = listRef.current?.getState().isAtEnd ?? true;
    if (isAtEnd !== follow.atEnd) transition({ type: "end-check", isAtEnd });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- onScroll can read isAtEnd before the list re-pins, leaving follow off at the end; the list's own signal restores it
  useEffect(
    () =>
      listRef.current?.getState().listen("isAtEnd", (isAtEnd) => {
        if (isAtEnd) transition({ type: "end-check", isAtEnd });
      }),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- transition only calls setFollow, which is stable.
    [],
  );

  const markSeen = ({ viewableItems }: OnViewableItemsChangedInfo<KinChatRow>) => {
    const seq = Math.max(
      0,
      ...viewableItems.map((token) => (token.item.type === "pending" ? 0 : kinRowSeq(token.item))),
    );
    if (seq > 0) transition({ type: "seen", seq });
  };
  const seenPairs: ViewabilityConfigCallbackPairs<KinChatRow> = SEEN_ROW_CONFIGS.map(
    (viewabilityConfig) => ({ viewabilityConfig, onViewableItemsChanged: markSeen }),
  );

  const jumpToEnd = () => {
    transition({ type: "jump-to-end" });
    // The list's own end, as maintainScrollAtEnd pins it: scrollToEnd counts the presence footer
    // twice and overshoots by its height.
    const list = listRef.current;
    if (list === null) return;
    const { contentLength, scrollLength } = list.getState();
    void list.scrollToOffset({ offset: contentLength - scrollLength, animated: !reduceMotion });
  };

  const toggleRun = (runId: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  };

  const onLinkPress = (href: string) => {
    const url = kinLinkToOpen(href);
    if (url !== null) void openLink(url);
  };

  const sendingSample = useRef(false);
  const sendSample = (body: string) => {
    if (sendingSample.current) return;
    sendingSample.current = true;
    void kinOutbox
      .enqueue({
        environmentId: props.environmentId,
        chatId: props.chatId,
        body,
        // A resent message asks the same lead it named the first time.
        mentions: kinMentionsIn(body, props.mentionable ?? []),
      })
      .then((queued) => {
        if (queued._tag !== "queued") return;
        jumpToEnd();
        void deliverKinOutbox();
      })
      .finally(() => {
        sendingSample.current = false;
      });
  };
  const renderItem = ({ item }: { readonly item: KinChatRow }) => {
    switch (item.type) {
      case "message": {
        const { message } = item;
        const widget = message.widgetId === null ? undefined : widgets.get(message.widgetId);
        const chips = kinReactionChips(
          streamed.reactions,
          message.messageId,
          viewerMemberId,
          reactorName,
        );
        // The host refuses reactions on approval and deferral cards.
        const reactable =
          canReact &&
          message.status === "posted" &&
          (message.widgetId === null ||
            (widget !== undefined && REACTABLE_WIDGETS.has(widget.type)));
        return (
          <KinMessageBubble
            row={item}
            markdownStyle={markdownStyle}
            ownMarkdownStyle={ownMarkdownStyle}
            direct={props.direct}
            onPressPreview={setPreviewFile}
            onOpenActions={
              message.status !== "deleted" && (reactable || message.body.trim().length > 0)
                ? () => openActions(message.messageId)
                : null
            }
            onLinkPress={onLinkPress}
            widget={widget}
            environmentId={props.environmentId}
            viewerPersonId={props.viewer.personId}
            reactions={chips}
            onReact={
              reactable
                ? (emoji: KinReactionEmoji) =>
                    void react({
                      environmentId: props.environmentId,
                      input: kinReactionToggle(chips, message.messageId, emoji),
                    })
                : null
            }
          />
        );
      }
      case "system": {
        const { retry } = item;
        // An unsent message is already a retry in flight.
        return (
          <KinSystemLine
            row={item}
            onRetry={retry === null || pending.length > 0 ? null : () => sendSample(retry)}
          />
        );
      }
      case "fold":
        return <KinFoldLine row={item} onToggle={() => toggleRun(item.runId)} />;
      case "pending":
        return (
          <KinPendingBubble
            entry={item.entry}
            environmentId={props.environmentId}
            onPressPreview={setPreviewFile}
            connected={props.connected}
            continues={item.continues}
            onEdit={() =>
              void editKinOutboxEntry(
                kinDraftKey(props.environmentId, props.orgId, props.chatId),
                item.entry.clientMessageId,
              )
            }
            onDiscard={() => void kinOutbox.discard(item.entry.clientMessageId)}
          />
        );
      case "day":
        return <KinDayLine row={item} />;
      case "draft":
        return (
          <KinDraftBubble
            row={item}
            markdownStyle={markdownStyle}
            onLinkPress={onLinkPress}
            direct={props.direct}
          />
        );
    }
  };

  const composer = props.readOnly ? (
    <View className="px-6 pt-3" style={{ paddingBottom: composerInset + 12 }}>
      <AppText textRole="footnote" className="text-center text-foreground-muted">
        {kinChatReadOnlyLine(props.agentName)}
      </AppText>
    </View>
  ) : (
    <KinComposer
      orgId={props.orgId}
      chatId={props.chatId}
      environmentId={props.environmentId}
      recipient={props.title}
      connected={props.connected}
      bottomInset={composerInset}
      onSend={jumpToEnd}
      onFocusChange={onComposerFocus}
      editorRef={editorRef}
      mentionable={props.mentionable}
    />
  );

  const startSample = (body: string) => {
    setComposerDraftText(kinDraftKey(props.environmentId, props.orgId, props.chatId), body);
    editorRef.current?.focus();
  };
  const intro =
    showIntro && props.agentName !== null ? (
      <KinIntro
        agentName={props.agentName}
        charter={props.charter}
        onSend={sendSample}
        onStart={startSample}
      />
    ) : null;

  const header = (
    <View className="gap-3 px-4 pb-3">
      {props.error === null ? null : (
        <View className="gap-3">
          <ErrorBanner message={props.error} />
          <View className="self-start">
            <Button tone="secondary" size="compact" label="Retry" onPress={props.onRetry} />
          </View>
        </View>
      )}
      {canLoadEarlier ? (
        <View className="items-center">
          <Button
            tone="secondary"
            size="compact"
            icon="chevron.up"
            label={
              loading
                ? "Loading earlier messages…"
                : paging.error === null
                  ? "Load earlier"
                  : "Retry"
            }
            accessibilityLabel={
              paging.error === null ? "Load earlier messages" : "Retry loading earlier messages"
            }
            loading={loading}
            disabled={loading}
            onPress={loadEarlier}
          />
        </View>
      ) : null}
      {paging.error === null ? null : <ErrorBanner message={paging.error} />}
      {rows.length === 0 ? null : intro}
    </View>
  );

  // Above the composer, so a long chat opened at its end still shows why it stopped updating.
  const noticeBar =
    notice === null ? null : (
      <View className="px-4 pb-3">
        <KinStaleNoticeView
          notice={notice}
          status={reconnect.status}
          reconnect={reconnect.reconnect}
          floating
        />
      </View>
    );

  // After a reset the feed is empty until the latest page reloads; that's not an empty chat.
  // Inside the list, so the first send keeps the same tree and the composer keeps the keyboard.
  const empty =
    rows.length === 0 && earlierPage === null && !live.needsHistoryReload ? (
      <View className="p-4">
        {intro ?? (
          <EmptyState
            variant="plain"
            title={
              props.agentName === null ? "No messages yet" : `Say hello to ${props.agentName}.`
            }
            detail={
              props.agentName === null
                ? "Messages in this chat show up here."
                : (props.about ?? "It reads every message here.")
            }
          />
        )}
      </View>
    ) : null;

  const actionsRow =
    actionsFor === null
      ? undefined
      : feedRows.find(
          (candidate) => candidate.type === "message" && candidate.message.messageId === actionsFor,
        );
  const actionsMessage = actionsRow?.type === "message" ? actionsRow.message : null;

  return (
    <View className="flex-1">
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- KinFeedScrollView is passed through the iOS-only spread below, as in the thread feed. */}
      <KeyboardAwareLegendList
        ref={listRef}
        style={{ flex: 1 }}
        // RN 0.81+ drops inset-area touches (facebook/react-native#54123).
        applyWorkaroundForContentInsetHitTestBug
        {...(Platform.OS === "ios" ? { ScrollViewComponent: KinFeedScrollView } : {})}
        // Manual insets, as in the thread feed: LegendList can't see the ones UIKit adds.
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
        scrollIndicatorInsets={{ top: barOverlap, bottom: 0 }}
        {...(barOverlap > 0 ? { contentInset: { top: barOverlap } } : {})}
        // The presence footer is the feed's last 32 pt, reserved even when empty.
        contentContainerStyle={{
          paddingTop: 8,
          paddingBottom: 4,
          ...(emptyMinHeight === null ? {} : { minHeight: emptyMinHeight }),
        }}
        onLayout={(event) => setListHeight(event.nativeEvent.layout.height)}
        data={rows}
        keyExtractor={(row) => row.key}
        // A draft recycles into the agent bubble its message will take.
        getItemType={(row) =>
          row.type === "message"
            ? row.own
              ? "own"
              : "other"
            : row.type === "draft"
              ? "other"
              : row.type
        }
        renderItem={renderItem}
        // Both reach rows only through renderItem, which the list doesn't watch.
        extraData={[
          streamed.widgets,
          streamed.reactions,
          canReact,
          markdownStyle,
          ownMarkdownStyle,
        ]}
        estimatedItemSize={72}
        drawDistance={500}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        keyboardOffset={keyboardOffset}
        keyboardLiftBehavior="whenAtEnd"
        scrollToOverflowEnabled
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd={
          followsEnd
            ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
            : false
        }
        maintainVisibleContentPosition={followsEnd ? false : { data: true, size: true }}
        onScroll={checkEnd}
        viewabilityConfigCallbackPairs={seenPairs}
        onScrollBeginDrag={() => transition({ type: "drag-begin" })}
        onScrollEndDrag={checkEnd}
        onMomentumScrollEnd={checkEnd}
        scrollEventThrottle={32}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={
          <KinPresenceLine
            presence={props.presence}
            avatar={presenceAvatar}
            visible={focused && followsEnd}
            stop={stopState}
            onStop={onStop}
          />
        }
      />
      <KeyboardStickyView
        enabled={!keyboardSuspect}
        pointerEvents="box-none"
        style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
        offset={{ closed: 0, opened: keyboardOffset }}
      >
        <View onLayout={onComposerLayout} pointerEvents="box-none">
          {unseen > 0 ? (
            // Out of the overlay's measured height, so the pill never moves the feed.
            <View
              pointerEvents="box-none"
              className="absolute inset-x-0 items-center pb-4"
              style={{ bottom: "100%" }}
            >
              <ControlPill
                variant="pill"
                icon="chevron.down"
                label="New messages"
                accessibilityLabel={`${unseen} new ${unseen === 1 ? "message" : "messages"}. Scroll to the latest.`}
                onPress={jumpToEnd}
              />
            </View>
          ) : null}
          {noticeBar}
          {composer}
        </View>
      </KeyboardStickyView>
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
      {actionsMessage === null ? null : (
        <KinFeedMessageActions
          key={actions.open}
          message={actionsMessage}
          widget={
            actionsMessage.widgetId === null ? undefined : widgets.get(actionsMessage.widgetId)
          }
          reactions={streamed.reactions}
          viewerMemberId={viewerMemberId}
          reactorName={reactorName}
          canReact={canReact}
          environmentId={props.environmentId}
          markdownStyle={markdownStyle}
          onClose={() => setActions((current) => ({ ...current, messageId: "" }))}
        />
      )}
    </View>
  );
}

/** The long-press sheet for one message, reacting through the same path as its chips. */
function KinFeedMessageActions(props: {
  readonly message: KinMessage;
  readonly widget: KinWidget | undefined;
  readonly reactions: ReadonlyArray<KinReaction>;
  readonly viewerMemberId: string | null;
  readonly reactorName: (memberId: string) => string | null;
  readonly canReact: boolean;
  readonly environmentId: EnvironmentId;
  readonly markdownStyle: NativeMarkdownTextStyle;
  readonly onClose: () => void;
}) {
  const react = useAtomCommand(kinClient.react, "react");
  const { message, widget } = props;
  const chips = kinReactionChips(
    props.reactions,
    message.messageId,
    props.viewerMemberId,
    props.reactorName,
  );
  // The host refuses reactions on approval and deferral cards.
  const reactable =
    props.canReact &&
    message.status === "posted" &&
    (message.widgetId === null || (widget !== undefined && REACTABLE_WIDGETS.has(widget.type)));
  return (
    <KinMessageSheet
      body={message.status === "deleted" ? "" : message.body}
      markdownStyle={props.markdownStyle}
      mine={new Set(chips.flatMap((chip) => (chip.mine ? [chip.emoji] : [])))}
      onReact={
        reactable
          ? (emoji) =>
              void react({
                environmentId: props.environmentId,
                input: kinReactionToggle(chips, message.messageId, emoji),
              })
          : null
      }
      onClose={props.onClose}
    />
  );
}

/** The feed's markdown colours for text on T3's user bubble. */
function useOwnBubbleMarkdownStyle(base: NativeMarkdownTextStyle): NativeMarkdownTextStyle {
  const text = String(
    StyleSheet.flatten(useResolveClassNames("text-user-bubble-foreground"))?.color ?? base.color,
  );
  return { ...base, color: text, strongColor: text };
}

// Messages fade under the floating bar instead of meeting it at a hard edge.
const KIN_FEED_EDGE_EFFECTS = {
  top: "soft",
  bottom: "hidden",
  left: "hidden",
  right: "hidden",
} as const;

function KinFeedScrollView(props: ComponentPropsWithRef<typeof Animated.ScrollView>) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }} scrollEdgeEffects={KIN_FEED_EDGE_EFFECTS}>
      <Animated.ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}
