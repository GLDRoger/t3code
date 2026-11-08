import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
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
  type KinMessage,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
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
import { useLocalDayStartMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { appAtomRegistry } from "../../state/atom-registry";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { KinFoldLine } from "./components/KinFoldLine";
import { KinDayLine, KinMessageBubble, KinSystemLine } from "./components/KinMessageBubble";
import {
  buildKinFeedRows,
  initialKinPaging,
  kinActivePaging,
  kinChatScreenState,
  kinChatStatusLine,
  kinEarlierPage,
  kinFeedViewer,
  kinMarkReadRearms,
  kinSeqToMarkRead,
  kinUnseenCount,
  latestKinSeq,
  mergeKinFeed,
  type KinChatScreenState,
  type KinFeedRow,
  type KinFeedViewer,
  type KinPaging,
} from "./state/kinChatFeed";
import { kinClient, type KinSynced } from "./state/kinClient";
import {
  initialKinFeedFollow,
  kinFollowsEnd,
  resolveKinFeedFollow,
  type KinFeedFollowEvent,
} from "./state/kinFeedFollow";
import {
  applyKinChatHistory,
  emptyKinChat,
  KIN_CACHED_MESSAGE_LIMIT,
  type KinChatState,
  type KinInboxState,
} from "./state/kinInboxModel";
import { kinChatTitle } from "./state/kinScreenState";
import { useKinHostAt } from "./state/useKinHost";

type KinChatParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly chatId: string;
};

type KinFixtures = typeof import("./state/kinChatFixtures");

export function KinChatScreen({ route }: StaticScreenProps<KinChatParams>) {
  // `KIN_FIXTURE_CHAT_ID`; required inside the `__DEV__` branch so release builds drop it.
  if (__DEV__ && route.params.chatId === "dev-fixture") {
    return <KinFixtureChat fixtures={require("./state/kinChatFixtures") as KinFixtures} />;
  }
  const environmentId = decodeEnvironmentId(route.params.environmentId);
  if (Option.isNone(environmentId)) {
    return (
      <KinChatPage
        chatId={route.params.chatId as KinChatId}
        title="Chat"
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

const decodeChatId = Schema.decodeUnknownOption(KinChatId);
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

  const retry = () => {
    if (environmentId === null) return;
    if (state._tag === "error" && state.retry === "orgs") {
      appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
    } else if (state._tag === "error" || (state._tag === "ready" && state.error !== null)) {
      appAtomRegistry.refresh(chatAtom);
    }
  };

  return (
    <KinChatPage
      chatId={chatId ?? (props.chatId as KinChatId)}
      title={summary === undefined ? "Chat" : kinChatTitle(summary, viewer.agentNames)}
      unread={summary?.unread ?? null}
      markRead={
        environmentId === null || chatId === null
          ? null
          : (seq) =>
              kinClient.markRead
                .run(appAtomRegistry, { environmentId, input: { chatId, seq } })
                .then((result) => result._tag === "Success")
      }
      state={state}
      viewer={viewer}
      onRetry={retry}
      readHistory={
        state._tag === "ready" && state.connected
          ? (input) => kinClient.readHistoryPage(state.environmentId, input)
          : null
      }
    />
  );
}

let fixtureMessages: ReadonlyArray<KinMessage> | null = null;
const readFixtureMessages = (fixtures: KinFixtures) =>
  (fixtureMessages ??= fixtures.makeKinFixtureMessages(500));

/** Dev only: 500 local messages, the latest 50 live, older ones paged in by "Load earlier". */
function KinFixtureChat({ fixtures }: { readonly fixtures: KinFixtures }) {
  const getFixtureMessages = () => readFixtureMessages(fixtures);
  const chat: KinSynced<KinChatState> = {
    value: { ...emptyKinChat, messages: getFixtureMessages().slice(-KIN_CACHED_MESSAGE_LIMIT) },
    live: true,
    savedAt: null,
  };
  return (
    <KinChatPage
      chatId={fixtures.KIN_FIXTURE_CHAT_ID}
      title="Tech lead"
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

function KinChatPage(props: {
  readonly chatId: KinChatId;
  readonly title: string;
  /** The inbox's unread count for this chat; null until the inbox loads. */
  readonly unread: number | null;
  /** Null where nothing can be marked, such as the dev fixture. */
  readonly markRead: MarkRead | null;
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
            // Paging, folds and follow belong to one chat.
            key={`${state.environmentId}:${props.chatId}`}
            chatId={props.chatId}
            chat={state.chat}
            connected={state.connected}
            error={state.error}
            onRetry={props.onRetry}
            viewer={props.viewer}
            readHistory={props.readHistory}
            unread={props.unread}
            markRead={props.markRead}
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
      case "unpaired":
        return (
          <EmptyState
            variant="plain"
            title="This Mac isn't paired with this phone"
            detail="Pair it again to open this chat."
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
            title={
              state.reason === "left"
                ? "You were removed from this chat"
                : "This chat isn't available"
            }
            detail={
              state.reason === "left"
                ? "Ask the chat's owner to add you back."
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

function KinChatFeed(props: {
  readonly chatId: KinChatId;
  readonly chat: KinSynced<KinChatState>;
  readonly connected: boolean;
  /** The stream failed after the feed loaded. */
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly viewer: KinFeedViewer;
  readonly readHistory: ReadHistory | null;
  readonly unread: number | null;
  readonly markRead: MarkRead | null;
}) {
  const listRef = useRef<LegendListRef>(null);
  const markedSeq = useRef(0);
  const attemptedSeq = useRef(0);
  const marking = useRef(false);
  const focused = useIsFocused();
  const dayStartMs = useLocalDayStartMs();
  const lastRequest = useRef(0);
  const reduceMotion = useReduceMotionEnabled();
  const markdownStyle = useMarkdownPreviewStyles().nativeTextStyle;
  const openLink = useOpenPullRequest();
  const [heldPaging, setPaging] = useState<KinPaging>(initialKinPaging);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(new Set());
  const [follow, setFollow] = useState(initialKinFeedFollow);

  const live = props.chat.value;
  const paging = kinActivePaging(heldPaging, live);
  const feed = mergeKinFeed(live, paging.earlier);
  const { messages } = feed;
  const rows = buildKinFeedRows(messages, props.viewer, expandedRuns, new Date(dayStartMs));
  const followsEnd = kinFollowsEnd(follow);
  const unseen = followsEnd ? 0 : kinUnseenCount(messages, follow.seenSeq, props.viewer.personId);
  const loading = paging.request !== null;
  const earlierPage = kinEarlierPage(props.chatId, messages, paging.exhausted);
  const canLoadEarlier = props.readHistory !== null && earlierPage !== null;
  const latestSeq = latestKinSeq(messages);
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
  }, [markRead, seesEnd, latestSeq, unread, connected, focused]);

  const transition = (event: KinFeedFollowEvent) =>
    setFollow((current) => resolveKinFeedFollow(current, event));
  const notice =
    (props.connected && props.chat.live) || props.chat.savedAt === null
      ? null
      : `${props.connected ? "Updating" : "Offline"}. Last updated ${offlineTime.format(new Date(props.chat.savedAt))}.`;

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
    transition({ type: "page-start", latestSeq: latestKinSeq(messages) });
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
    const next = resolveKinFeedFollow(follow, {
      type: "end-check",
      isAtEnd,
      latestSeq: latestKinSeq(messages),
    });
    if (next !== follow) setFollow(next);
  };

  const jumpToEnd = () => {
    transition({ type: "jump-to-end" });
    void listRef.current?.scrollToEnd({ animated: !reduceMotion });
  };

  const toggleRun = (runId: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  };

  const renderItem = ({ item }: { readonly item: KinFeedRow }) => {
    switch (item.type) {
      case "message":
        return (
          <KinMessageBubble
            row={item}
            markdownStyle={markdownStyle}
            onLinkPress={(href) => void openLink(href)}
          />
        );
      case "system":
        return <KinSystemLine row={item} />;
      case "fold":
        return <KinFoldLine row={item} onToggle={() => toggleRun(item.runId)} />;
      case "day":
        return <KinDayLine row={item} />;
    }
  };

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
      {notice === null ? null : (
        <Notice {...(props.connected ? {} : { icon: "wifi.slash" as const })} message={notice} />
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
    </View>
  );

  // After a reset the feed is empty until the latest page reloads; that's not an empty chat.
  if (rows.length === 0 && earlierPage === null && !live.needsHistoryReload) {
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
        extraData={markdownStyle}
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
        onScroll={checkEnd}
        onScrollBeginDrag={() => transition({ type: "drag-begin" })}
        onScrollEndDrag={checkEnd}
        onMomentumScrollEnd={checkEnd}
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
