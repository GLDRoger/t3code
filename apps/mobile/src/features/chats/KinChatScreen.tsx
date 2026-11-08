import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KinChatId,
  type EnvironmentId,
  type KinChatHistoryInput,
  type KinChatHistoryResult,
  type KinChatSummary,
  type KinMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, type AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { LoadingStrip } from "../../components/ui/LoadingStrip";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { useReduceMotionEnabled } from "../../lib/appState";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { appAtomRegistry } from "../../state/atom-registry";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { KinFoldLine } from "./components/KinFoldLine";
import { KinMessageBubble, KinSystemLine } from "./components/KinMessageBubble";
import {
  KIN_FIXTURE_AGENT,
  KIN_FIXTURE_CHAT_ID,
  KIN_FIXTURE_OWNER,
  makeKinFixtureMessages,
  readKinFixtureHistory,
} from "./state/kinChatFixtures";
import {
  buildKinFeedRows,
  kinChatScreenState,
  kinChatStatusLine,
  kinEarlierPage,
  kinFeedViewer,
  kinUnseenCount,
  latestKinSeq,
  mergeKinFeed,
  type KinChatScreenState,
  type KinFeedRow,
  type KinFeedViewer,
} from "./state/kinChatFeed";
import { kinClient, type KinSynced } from "./state/kinClient";
import {
  applyKinChatHistory,
  emptyKinChat,
  KIN_CACHED_MESSAGE_LIMIT,
  type KinChatState,
  type KinInboxState,
} from "./state/kinInboxModel";
import { useKinHost } from "./state/useKinHost";

type KinChatParams = { readonly orgId: string; readonly chatId: string };

export function KinChatScreen({ route }: StaticScreenProps<KinChatParams>) {
  if (__DEV__ && route.params.chatId === KIN_FIXTURE_CHAT_ID) return <KinFixtureChat />;
  return <KinLiveChat orgId={route.params.orgId} chatId={route.params.chatId} />;
}

type ChatResult = AsyncResult.AsyncResult<KinSynced<KinChatState>, unknown> | null;
type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;
const noChatAtom: Atom.Atom<ChatResult> = Atom.make<ChatResult>(null);
const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);

const decodeChatId = Schema.decodeUnknownOption(KinChatId);

function chatTitle(summary: KinChatSummary | undefined, viewer: KinFeedViewer): string {
  if (summary?.title) return summary.title;
  const agent = summary?.members.find(
    (member) => member.principal._tag === "agent" && member.leftAt === null,
  )?.principal;
  return (agent?._tag === "agent" ? viewer.agentNames.get(agent.agentId) : undefined) ?? "Chat";
}

function KinLiveChat(props: { readonly orgId: string; readonly chatId: string }) {
  const host = useKinHost();
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

  const retry = () => {
    if (environmentId === null || state._tag !== "error") return;
    if (state.retry === "orgs") {
      appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
    } else {
      appAtomRegistry.refresh(chatAtom);
    }
  };

  const readHistory = (environment: EnvironmentId, input: KinChatHistoryInput) =>
    Effect.runPromiseExit(
      AtomRegistry.getResult(
        appAtomRegistry,
        kinClient.history({ environmentId: environment, input }),
      ),
    );

  return (
    <KinChatPage
      chatId={chatId ?? KIN_FIXTURE_CHAT_ID}
      title={chatTitle(summary, viewer)}
      state={state}
      viewer={viewer}
      onRetry={retry}
      readHistory={
        state._tag === "ready" && state.connected
          ? (input) => readHistory(state.environmentId, input)
          : null
      }
    />
  );
}

let fixtureMessages: ReadonlyArray<KinMessage> | null = null;
const getFixtureMessages = () => (fixtureMessages ??= makeKinFixtureMessages(500));

/** Dev only: 500 local messages, the latest 50 live, older ones paged in by "Load earlier". */
function KinFixtureChat() {
  const chat: KinSynced<KinChatState> = {
    value: { ...emptyKinChat, messages: getFixtureMessages().slice(-KIN_CACHED_MESSAGE_LIMIT) },
    live: true,
    savedAt: null,
  };
  return (
    <KinChatPage
      chatId={KIN_FIXTURE_CHAT_ID}
      title="Tech lead"
      state={{
        _tag: "ready",
        environmentId: "dev-fixture" as EnvironmentId,
        connected: true,
        chat,
      }}
      viewer={{
        personId: KIN_FIXTURE_OWNER,
        agentNames: new Map([[KIN_FIXTURE_AGENT, "Tech lead"]]),
      }}
      onRetry={() => {}}
      readHistory={(input) =>
        Promise.resolve(Exit.succeed(readKinFixtureHistory(getFixtureMessages(), input)))
      }
    />
  );
}

type ReadHistory = (
  input: KinChatHistoryInput,
) => Promise<Exit.Exit<KinChatHistoryResult, unknown>>;

function KinChatPage(props: {
  readonly chatId: KinChatId;
  readonly title: string;
  readonly state: KinChatScreenState;
  readonly viewer: KinFeedViewer;
  readonly onRetry: () => void;
  /** Null while older pages can't be read, such as offline. */
  readonly readHistory: ReadHistory | null;
}) {
  const navigation = useNavigation();
  const topInset = useContentTopInset();
  const { state } = props;
  const subtitle = state._tag === "ready" ? kinChatStatusLine(state.chat.value.widgets) : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} subtitle={subtitle} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        {state._tag === "ready" ? (
          <KinChatFeed
            chatId={props.chatId}
            chat={state.chat}
            environmentId={state.environmentId}
            connected={state.connected}
            viewer={props.viewer}
            readHistory={props.readHistory}
          />
        ) : (
          <KinChatStateView state={state} onRetry={props.onRetry} />
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
  readonly onRetry: () => void;
}) {
  const navigation = useNavigation();
  const { state } = props;
  const body = (() => {
    switch (state._tag) {
      case "loading":
        return null;
      case "offline":
        return (
          <EmptyState
            variant="plain"
            title="Kin is offline"
            detail="This chat loads when the Kin environment reconnects."
          />
        );
      case "noHost":
        return (
          <EmptyState
            variant="plain"
            title="Kin isn't set up on this environment"
            detail="Connect this phone to a T3 server that runs Kin."
            actionLabel="Open environments"
            onAction={() => navigation.navigate("SettingsEnvironments")}
          />
        );
      case "unauthorized":
        return (
          <EmptyState
            variant="plain"
            title="This device can't read Kin chats"
            detail="Pair it again from the Mac."
          />
        );
      case "noIdentity":
        return (
          <EmptyState
            variant="plain"
            title="Kin doesn't know who you are on this server yet"
            detail="Ask whoever runs Kin here to add you, then come back."
          />
        );
      case "gone":
        return (
          <EmptyState
            variant="plain"
            title={state.reason === "left" ? "You left this chat" : "This chat isn't available"}
            detail={
              state.reason === "unavailable"
                ? "Kin is turned off on this server."
                : "It may have been removed, or you're no longer a member."
            }
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

interface Paging {
  readonly earlier: KinChatState;
  readonly exhausted: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

const initialPaging: Paging = {
  earlier: emptyKinChat,
  exhausted: false,
  loading: false,
  error: null,
};

const offlineTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function KinChatFeed(props: {
  readonly chatId: KinChatId;
  readonly chat: KinSynced<KinChatState>;
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly viewer: KinFeedViewer;
  readonly readHistory: ReadHistory | null;
}) {
  const listRef = useRef<LegendListRef>(null);
  const reduceMotion = useReduceMotionEnabled();
  const markdownStyle = useMarkdownPreviewStyles().nativeTextStyle;
  const openLink = useOpenPullRequest();
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(new Set());
  const [atEnd, setAtEnd] = useState(true);
  // The latest seq when the reader left the end; later messages from others light the pill.
  const [seenSeq, setSeenSeq] = useState(0);
  // Set by "Load earlier" so the prepended page keeps the reader's place, even at the end.
  const [holdPosition, setHoldPosition] = useState(false);

  const feed = mergeKinFeed(props.chat.value, paging.earlier);
  const { messages } = feed;
  const widgets = new Map(feed.widgets.map((widget) => [widget.widgetId, widget]));
  const rows = buildKinFeedRows(messages, props.viewer, expandedRuns);
  const unseen = atEnd ? 0 : kinUnseenCount(messages, seenSeq, props.viewer.personId);
  const followsEnd = atEnd && !holdPosition;
  const earlierPage = kinEarlierPage(props.chatId, messages, paging.exhausted);
  const canLoadEarlier = props.readHistory !== null && earlierPage !== null;
  const notice =
    (props.connected && props.chat.live) || props.chat.savedAt === null
      ? null
      : `${props.connected ? "Updating" : "Offline"}. Last updated ${offlineTime.format(new Date(props.chat.savedAt))}.`;

  const loadEarlier = () => {
    const read = props.readHistory;
    if (read === null || earlierPage === null || paging.loading) return;
    setHoldPosition(true);
    setPaging((current) => ({ ...current, loading: true, error: null }));
    void read(earlierPage).then((exit) => {
      setPaging((current) =>
        Exit.isSuccess(exit)
          ? {
              earlier: applyKinChatHistory(current.earlier, exit.value),
              exhausted: !exit.value.hasMore,
              loading: false,
              error: null,
            }
          : { ...current, loading: false, error: "Couldn't load earlier messages." },
      );
    });
  };

  const handleScroll = () => {
    const isAtEnd = listRef.current?.getState().isAtEnd ?? true;
    if (isAtEnd === atEnd) return;
    if (!isAtEnd) setSeenSeq(latestKinSeq(messages));
    setAtEnd(isAtEnd);
  };

  const jumpToEnd = () => {
    setHoldPosition(false);
    setAtEnd(true);
    void listRef.current?.scrollToEnd({ animated: !reduceMotion });
  };

  const toggleRun = (runId: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  };

  const onLinkPress = (href: string) => void openLink(href);

  const renderItem = ({ item }: { readonly item: KinFeedRow }) => {
    switch (item.type) {
      case "message":
        return (
          <KinMessageBubble
            row={item}
            markdownStyle={markdownStyle}
            onLinkPress={onLinkPress}
            widget={item.message.widgetId === null ? undefined : widgets.get(item.message.widgetId)}
            environmentId={props.environmentId}
          />
        );
      case "system":
        return <KinSystemLine row={item} />;
      case "fold":
        return <KinFoldLine row={item} onToggle={() => toggleRun(item.runId)} />;
    }
  };

  const header = (
    <View className="gap-3 px-4 pb-3">
      {notice === null ? null : (
        <Notice {...(props.connected ? {} : { icon: "wifi.slash" as const })} message={notice} />
      )}
      {canLoadEarlier ? (
        <View className="items-center">
          <Button
            tone="secondary"
            size="compact"
            icon="chevron.up"
            label={paging.loading ? "Loading earlier messages…" : "Load earlier"}
            accessibilityLabel="Load earlier messages"
            loading={paging.loading}
            disabled={paging.loading}
            onPress={loadEarlier}
          />
        </View>
      ) : null}
      {paging.error === null ? null : <ErrorBanner message={paging.error} />}
    </View>
  );

  if (rows.length === 0 && earlierPage === null) {
    return (
      <View className="flex-1 justify-center p-4">
        {header}
        <EmptyState
          variant="plain"
          title="Say hello to your lead."
          detail="It reads every message here."
        />
      </View>
    );
  }

  return (
    <View className="flex-1">
      <LegendList
        ref={listRef}
        renderScrollComponent={NativeScrollView}
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 16 }}
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => (row.type === "message" ? (row.own ? "own" : "other") : row.type)}
        renderItem={renderItem}
        extraData={feed.widgets}
        estimatedItemSize={72}
        drawDistance={500}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd={
          followsEnd
            ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
            : false
        }
        maintainVisibleContentPosition={followsEnd ? false : { data: true, size: true }}
        onScroll={handleScroll}
        onScrollBeginDrag={() => {
          if (holdPosition) setHoldPosition(false);
        }}
        scrollEventThrottle={32}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
      />
      {unseen > 0 ? (
        <View pointerEvents="box-none" className="absolute inset-x-0 bottom-4 items-center">
          <ControlPill
            variant="pill"
            icon="chevron.down"
            label="New messages"
            accessibilityLabel={`${unseen} new ${unseen === 1 ? "message" : "messages"}. Scroll to the latest.`}
            className="border border-border shadow-md shadow-black/10"
            onPress={jumpToEnd}
          />
        </View>
      ) : null}
    </View>
  );
}
