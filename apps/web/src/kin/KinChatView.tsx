import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
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
} from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinFeedMessages } from "@t3tools/client-runtime/kin/kinCardPresentation";
import {
  initialKinFeedFollow,
  kinFollowsEnd,
  resolveKinFeedFollow,
  type KinFeedFollowEvent,
} from "@t3tools/client-runtime/kin/kinFeedFollow";
import {
  applyKinChatHistory,
  emptyKinChat,
  type KinChatState,
  type KinInboxState,
} from "@t3tools/client-runtime/kin/kinInboxModel";
import { KIN_INTRO_PROMPTS, kinIntroVisible } from "@t3tools/client-runtime/kin/kinIntro";
import {
  kinPresenceLine,
  kinPresenceNeedsClock,
  kinPresenceTimerStart,
} from "@t3tools/client-runtime/kin/kinLive";
import {
  KIN_MESSAGE_MAX_LENGTH,
  splitKinOutbox,
  type KinOutboxEntry,
} from "@t3tools/client-runtime/kin/kinOutbox";
import {
  kinReactionChips,
  kinReactionToggle,
  kinViewerMemberId,
} from "@t3tools/client-runtime/kin/kinReactions";
import {
  kinAvatarView,
  kinChatMuted,
  kinChatTitle,
  kinDirectAgentName,
  kinOwnedLeadAgentId,
  type KinAvatarView,
} from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinSynced } from "@t3tools/client-runtime/kin/kinStreams";
import {
  KinChatId,
  type EnvironmentId,
  type KinAttachment,
  type KinChatMember,
  type KinLeadsListResult,
  type KinPresence,
  type KinReactionEmoji,
  type KinWakeupId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AsyncResult } from "effect/reactivity";
import { ArrowDownIcon, ArrowLeftIcon, ChevronUpIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { ComposerAttachButton } from "../components/chat/ComposerAttachmentStrip";
import { shouldHandleComposerAttachmentPaste } from "../components/chat/composerAttachmentFiles";
import { ExpandedImageDialogHost } from "../components/chat/ExpandedImageDialog";
import {
  ComposerPrimaryActions,
  StopGenerationButton,
} from "../components/chat/ComposerPrimaryActions";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { WorkingTimer } from "../components/chat/TimelineWorkGroupRows";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import {
  KinComposerAttachmentStrip,
  kinPreviewKey,
  useKinComposerAttachments,
} from "./KinComposerAttachments";
import { kinClient } from "./kinClient";
import { KinLeadSheet } from "./KinLeadSheet";
import { deliverKinOutbox, kinOutbox, startKinOutbox } from "./kinOutbox";
import { kinFeedDisplay } from "./kinFeedDisplay";
import {
  formatKinMessageTime,
  KinDayRow,
  KinDraftRow,
  KinFoldRow,
  KinMessageRow,
  KinPendingRow,
  KinSystemRow,
} from "./KinMessageRows";
import { useKinPresenceNow, useNowMinuteMs } from "./useKinClock";
import { useKinHostAt } from "./useKinHost";

type ChatResult = AsyncResult.AsyncResult<KinSynced<KinChatState>, unknown> | null;
type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;
type LeadsResult = AsyncResult.AsyncResult<KinLeadsListResult, unknown> | null;
const noLeadsAtom: Atom.Atom<LeadsResult> = Atom.make<LeadsResult>(null);
const noChatAtom: Atom.Atom<ChatResult> = Atom.make<ChatResult>(null);
const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);
const decodeChatId = Schema.decodeUnknownOption(KinChatId);

// Mirrors the host's reactable cards; the host still refuses the rest.
const REACTABLE_WIDGETS = new Set(["choice", "task", "routine"]);

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
const kinDraftAtom = Atom.family((_key: string) =>
  Atom.make("").pipe(Atom.keepAlive, Atom.withLabel("kin:draft")),
);
const kinDraftKey = (environmentId: EnvironmentId, orgId: string, chatId: string) =>
  `${environmentId}:${orgId}:${chatId}`;

/** Puts an unsent body back in the draft, ahead of anything typed since. */
function restoreDraft(key: string, body: string) {
  const atom = kinDraftAtom(key);
  const typed = appAtomRegistry.get(atom);
  appAtomRegistry.set(atom, typed.trim().length === 0 ? body : `${body}\n\n${typed}`);
}

/** A lead's charter as the empty chat's opening lines: whole when short, else cut at a word. */
function kinIntroCharter(charter: string): string | null {
  const text = charter.trim();
  if (text === "") return null;
  if (text.length <= 240) return text;
  const cut = text.slice(0, 240);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120)).replace(/[\s.,;:]+$/, "")}…`;
}

/** One Kin chat, from the route's environment, org and chat. */
export function KinChatView(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly chatId: string;
}) {
  startKinOutbox();
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
  const canInterrupt = useAtomValue(kinClient.leadInterrupt.permissionAtom(props.environmentId));
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
  const ownedAgentId = summary === undefined ? null : kinOwnedLeadAgentId(summary, viewer.personId);
  // Only the viewer's own leads have a profile to open; a teammate's list is empty.
  const leadsAtom: Atom.Atom<LeadsResult> =
    environmentId === null || summary === undefined || ownedAgentId === null
      ? noLeadsAtom
      : kinClient.leads({ environmentId, input: { orgId: summary.orgId } });
  const leads = useAtomValue(leadsAtom);
  const lead =
    leads?._tag === "Success"
      ? (leads.value.leads.find((held) => held.agentId === ownedAgentId) ?? null)
      : null;
  const [profileOpen, setProfileOpen] = useState(false);
  const nowMs = useNowMinuteMs();
  const muted =
    summary !== undefined &&
    viewer.personId !== null &&
    kinChatMuted(summary, new Set([viewer.personId]), nowMs);
  const title = summary === undefined ? "Chat" : kinChatTitle(summary, viewer.agentNames);
  const avatar =
    summary === undefined
      ? null
      : kinAvatarView(
          summary,
          summary.members.find(
            (member) => member.leftAt === null && member.principal._tag === "agent",
          ) ?? null,
        );

  const retry = () => {
    if (environmentId === null) return;
    if (state._tag === "error" && state.retry === "orgs") {
      appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
    } else {
      appAtomRegistry.refresh(chatAtom);
    }
  };

  const presence =
    state._tag === "ready" && state.connected && state.chat.live
      ? state.chat.value.presence.at(-1)
      : undefined;
  const tasks = state._tag === "ready" ? kinChatStatusLine(state.chat.value.widgets) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <KinChatHeader
        title={title}
        avatar={avatar}
        presence={presence}
        tasks={tasks}
        muted={muted}
        onOpenProfile={lead === null ? null : () => setProfileOpen(true)}
      />
      {lead === null || avatar === null || environmentId === null || chatId === null ? null : (
        <KinLeadSheet
          open={profileOpen}
          onOpenChange={setProfileOpen}
          lead={lead}
          avatar={avatar}
          environmentId={environmentId}
          chatId={chatId}
          muted={muted}
        />
      )}
      {state._tag === "ready" ? (
        <KinChatFeed
          // Paging, folds and follow belong to one chat.
          key={`${state.environmentId}:${props.chatId}`}
          orgId={props.orgId}
          title={title}
          environmentId={state.environmentId}
          chatId={chatId ?? (props.chatId as KinChatId)}
          agentName={summary === undefined ? null : kinDirectAgentName(summary, viewer.agentNames)}
          chat={state.chat}
          connected={state.connected}
          error={state.error}
          onRetry={retry}
          viewer={viewer}
          unread={summary?.unread ?? null}
          presence={presence}
          stopLead={
            summary === undefined || ownedAgentId === null || !canInterrupt
              ? null
              : (wakeupId) =>
                  kinClient.leadInterrupt
                    .run(appAtomRegistry, {
                      environmentId: state.environmentId,
                      input: { orgId: summary.orgId, wakeupId: wakeupId as KinWakeupId },
                    })
                    .then((result) => result._tag === "Success")
          }
          charter={lead === null ? null : kinIntroCharter(lead.charter)}
          members={summary?.members ?? []}
          direct={summary?.kind === "direct"}
          ownsLead={ownedAgentId !== null}
        />
      ) : (
        <KinChatStateView state={state} onRetry={retry} />
      )}
    </div>
  );
}

/** Who the chat is with, and what they are doing: presence while a lead works, open tasks otherwise. */
function KinChatHeader(props: {
  readonly title: string;
  readonly avatar: KinAvatarView | null;
  readonly presence: KinPresence | undefined;
  readonly tasks: string | null;
  readonly muted: boolean;
  /** Opens the lead's profile; null for a chat that has none to show. */
  readonly onOpenProfile: (() => void) | null;
}) {
  const now = useKinPresenceNow(kinPresenceNeedsClock(props.presence));
  const subtitle = kinPresenceLine(props.presence, now)?.subtitle ?? props.tasks;
  const identity = (
    <>
      {props.avatar === null ? null : <KinAvatar avatar={props.avatar} size="sm" />}
      <WorkspaceBreadcrumb ariaLabel="Chat" className="shrink">
        <WorkspaceBreadcrumbItem current>
          <h1 className="min-w-0">
            <WorkspaceBreadcrumbText>{props.title}</WorkspaceBreadcrumbText>
          </h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </>
  );
  return (
    <WorkspacePageHeader electron={isElectron}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Back to chats"
        className="md:hidden"
        render={<Link to="/kin" />}
      >
        <ArrowLeftIcon />
      </Button>
      {props.onOpenProfile === null ? (
        identity
      ) : (
        <button
          type="button"
          aria-label={`${props.title}: open profile`}
          className="-mx-1.5 flex min-w-0 shrink items-center gap-3 rounded-md px-1.5 py-1 outline-none ring-ring [-webkit-app-region:no-drag] hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
          onClick={props.onOpenProfile}
        >
          {identity}
        </button>
      )}
      {props.muted ? <span className="sr-only">Muted</span> : null}
      {subtitle === null ? null : (
        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{subtitle}</p>
      )}
    </WorkspacePageHeader>
  );
}

const STATE_COPY: Record<
  Exclude<KinChatScreenState["_tag"], "ready" | "loading" | "error" | "gone">,
  { readonly title: string; readonly detail: string }
> = {
  offline: {
    title: "Kin is offline",
    detail: "This chat loads when the Kin environment reconnects.",
  },
  noHost: {
    title: "Kin isn't set up on this environment",
    detail: "Connect to a T3 server that runs Kin.",
  },
  unpaired: {
    title: "This browser isn't connected to that server",
    detail: "Pair it with the server that runs Kin to open this chat.",
  },
  unauthorized: {
    title: "This browser can't read Kin chats",
    detail: "Pair it again with the server that runs Kin.",
  },
  noIdentity: {
    title: "Kin doesn't know who you are on this server yet",
    detail: "Ask whoever runs Kin here to add you, then come back.",
  },
};

function KinChatStateView(props: {
  readonly state: Exclude<KinChatScreenState, { readonly _tag: "ready" }>;
  readonly onRetry: () => void;
}) {
  const { state } = props;
  if (state._tag === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center" role="status">
        <Spinner aria-label="Loading chat" />
      </div>
    );
  }
  if (state._tag === "error") {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  const copy =
    state._tag === "gone"
      ? {
          title:
            state.reason === "left"
              ? "You were removed from this chat"
              : state.reason === "disabled"
                ? "Kin is turned off on this server"
                : "This chat isn't available",
          detail:
            state.reason === "left"
              ? "Ask the chat's owner to add you back."
              : state.reason === "disabled"
                ? "Ask whoever runs Kin here to turn it back on, then come back."
                : state.reason === "not_found" || state.reason === "not_allowed"
                  ? "It may have been removed, or you're no longer a member."
                  : "Kin couldn't open this chat. Go back to your chats and try again.",
        }
      : STATE_COPY[state._tag];
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const offlineTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

type KinChatRow =
  | KinFeedRow
  | { readonly type: "pending"; readonly key: string; readonly entry: KinOutboxEntry };

type StopState = "idle" | "stopping" | "failed";

function KinChatFeed(props: {
  readonly orgId: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly chatId: KinChatId;
  readonly agentName: string | null;
  readonly chat: KinSynced<KinChatState>;
  readonly connected: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly viewer: KinFeedViewer;
  readonly unread: number | null;
  readonly presence: KinPresence | undefined;
  readonly stopLead: ((wakeupId: string) => Promise<boolean>) | null;
  /** What the owner wrote this lead is for; the intro shows it before the first message. */
  readonly charter: string | null;
  readonly members: ReadonlyArray<KinChatMember>;
  readonly direct: boolean;
  readonly ownsLead: boolean;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const markedSeq = useRef(0);
  const attemptedSeq = useRef(0);
  const marking = useRef(false);
  const lastRequest = useRef(0);
  const nowMs = useNowMinuteMs();
  const draftKey = kinDraftKey(props.environmentId, props.orgId, props.chatId);
  const previewKey = kinPreviewKey(draftKey);
  const [heldPaging, setPaging] = useState<KinPaging>(initialKinPaging);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(new Set());
  const [follow, setFollow] = useState(() =>
    initialKinFeedFollow(latestKinSeq(props.chat.value.messages)),
  );
  const [stop, setStop] = useState<{ readonly wakeupId: string; readonly state: StopState }>({
    wakeupId: "",
    state: "idle",
  });

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
      : member.role === "owner"
        ? "Owner"
        : "Member";
  };
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const feedRows = buildKinFeedRows(
    kinFeedMessages(messages, widgets),
    props.viewer,
    expandedRuns,
    dayStart,
    live.drafts,
  );
  const display = kinFeedDisplay({
    rows: feedRows,
    direct: props.direct,
    formatTime: formatKinMessageTime,
  });
  const shownRows = feedRows.some((row) => display.get(row.key)?.hidden === true)
    ? feedRows.filter((row) => display.get(row.key)?.hidden !== true)
    : feedRows;
  const rows: ReadonlyArray<KinChatRow> =
    pending.length === 0
      ? shownRows
      : [
          ...shownRows,
          ...pending.map((entry) => ({
            type: "pending" as const,
            key: `pending:${entry.clientMessageId}`,
            entry,
          })),
        ];

  const { presence, stopLead } = props;
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

  const followsEnd = kinFollowsEnd(follow);
  const unseen = followsEnd ? 0 : kinUnseenCount(messages, follow.seenSeq, props.viewer.personId);
  const loading = paging.request !== null;
  const earlierPage = kinEarlierPage(props.chatId, messages, paging.exhausted);
  const canLoadEarlier = props.connected && earlierPage !== null;
  const latestSeq = latestKinSeq(messages);
  const showIntro = kinIntroVisible({
    ownsLead: props.ownsLead,
    agentName: props.agentName,
    viewerPersonId: props.viewer.personId,
    messages,
    pendingCount: pending.length,
    historyIncomplete: earlierPage !== null || live.needsHistoryReload,
  });

  const { connected, unread } = props;
  const focused = typeof document === "undefined" || document.visibilityState === "visible";
  const markRead = (seq: number) =>
    kinClient.markRead
      .run(appAtomRegistry, {
        environmentId: props.environmentId,
        input: { chatId: props.chatId, seq },
      })
      .then((result) => result._tag === "Success");
  const seesEnd = followsEnd && focused && connected && props.chat.live;
  const reading = useRef({ markRead, seesEnd, latestSeq, unread, connected, focused });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host what the reader has seen, one call in flight at a time
  useEffect(() => {
    const next = { markRead, seesEnd, latestSeq, unread, connected, focused };
    if (kinMarkReadRearms(reading.current, next)) attemptedSeq.current = markedSeq.current;
    reading.current = next;
    const send = () => {
      const current = reading.current;
      if (marking.current) return;
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- markRead is rebuilt each render; the ref carries the latest.
  }, [seesEnd, latestSeq, unread, connected, focused]);

  const transition = (event: KinFeedFollowEvent) =>
    setFollow((current) => resolveKinFeedFollow(current, event));

  const loadEarlier = () => {
    if (!canLoadEarlier || earlierPage === null || loading) return;
    const request = ++lastRequest.current;
    // Starts from the paging that fits the stream, so pages dropped by a reset stay dropped.
    setPaging({
      ...paging,
      anchorSeq: paging.anchorSeq ?? live.messages[0]?.seq ?? null,
      request,
      error: null,
    });
    transition({ type: "page-start" });
    void kinClient.readHistoryPage(props.environmentId, earlierPage).then((exit) => {
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
    if (isAtEnd) transition({ type: "seen", seq: latestSeq });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- onScroll can read isAtEnd before the list re-pins, leaving follow off at the end; the list's own signal restores it
  useEffect(
    () =>
      listRef.current?.getState().listen("isAtEnd", (isAtEnd) => {
        if (!isAtEnd) return;
        transition({ type: "end-check", isAtEnd });
        transition({ type: "seen", seq: reading.current.latestSeq });
      }),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- transition only calls setFollow, which is stable.
    [],
  );

  const prefersReducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const jumpToEnd = () => {
    transition({ type: "jump-to-end" });
    transition({ type: "seen", seq: latestSeq });
    void listRef.current?.scrollToEnd({ animated: !prefersReducedMotion });
  };

  const toggleRun = (runId: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  };

  const sendText = async (body: string, attachments: ReadonlyArray<KinAttachment> = []) => {
    const queued = await kinOutbox.enqueue({
      environmentId: props.environmentId,
      chatId: props.chatId,
      body,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (queued._tag !== "queued") return false;
    jumpToEnd();
    void deliverKinOutbox();
    return true;
  };

  const renderItem = ({ item }: { readonly item: KinChatRow }) => {
    switch (item.type) {
      case "message": {
        const { message } = item;
        const shown = display.get(item.key);
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
          <KinMessageRow
            row={item}
            head={shown?.head ?? null}
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
            previewKey={previewKey}
          />
        );
      }
      case "system": {
        const { retry } = item;
        // An unsent message is already a retry in flight.
        return (
          <KinSystemRow
            body={item.text}
            onRetry={retry === null || pending.length > 0 ? null : () => void sendText(retry)}
          />
        );
      }
      case "fold":
        return <KinFoldRow row={item} onToggle={() => toggleRun(item.runId)} />;
      case "pending":
        return (
          <KinPendingRow
            entry={item.entry}
            connected={props.connected}
            environmentId={props.environmentId}
            previewKey={previewKey}
            onEdit={() =>
              void kinOutbox.discard(item.entry.clientMessageId).then((body) => {
                if (body === null) return;
                restoreDraft(draftKey, body);
                composerRef.current?.focus();
              })
            }
            onDiscard={() => void kinOutbox.discard(item.entry.clientMessageId)}
          />
        );
      case "day":
        return <KinDayRow label={item.label} />;
      case "draft":
        return <KinDraftRow row={item} environmentId={props.environmentId} direct={props.direct} />;
    }
  };

  const notice =
    (props.connected && props.chat.live) || props.chat.savedAt === null
      ? null
      : `${props.connected ? "Updating" : "Offline"}. Last updated ${offlineTime.format(new Date(props.chat.savedAt))}.`;

  const intro =
    showIntro && props.agentName !== null ? (
      <KinIntro
        agentName={props.agentName}
        charter={props.charter}
        onSend={(text) => void sendText(text)}
        onStart={(text) => {
          appAtomRegistry.set(kinDraftAtom(draftKey), text);
          composerRef.current?.focus();
        }}
      />
    ) : null;

  const header = (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pb-3 pt-3">
      {props.error === null ? null : (
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
          <Button size="sm" variant="outline" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      )}
      {canLoadEarlier ? (
        <Button
          size="sm"
          variant="outline"
          className="self-center"
          aria-busy={loading}
          disabled={loading}
          onClick={loadEarlier}
        >
          {loading ? <Spinner /> : <ChevronUpIcon />}
          {loading
            ? "Loading earlier messages…"
            : paging.error === null
              ? "Load earlier"
              : "Retry loading earlier"}
        </Button>
      ) : null}
      {paging.error === null ? null : (
        <Alert variant="error">
          <AlertDescription>{paging.error}</AlertDescription>
        </Alert>
      )}
      {rows.length === 0 ? null : intro}
    </div>
  );

  // After a reset the feed is empty until the latest page reloads; that's not an empty chat.
  const empty =
    rows.length === 0 && earlierPage === null && !live.needsHistoryReload
      ? (intro ?? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>
                {props.agentName === null ? "No messages yet" : `Say hello to ${props.agentName}`}
              </EmptyTitle>
              <EmptyDescription>
                {props.agentName === null
                  ? "Messages in this chat show up here."
                  : "Your first message starts the chat."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ))
      : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <LegendList<KinChatRow>
        ref={listRef}
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
        extraData={[streamed.widgets, streamed.reactions, canReact, display]}
        estimatedItemSize={72}
        recycleItems={false}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd={
          followsEnd
            ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
            : false
        }
        maintainVisibleContentPosition={followsEnd ? false : { data: true, size: true }}
        onScroll={checkEnd}
        className="scrollbar-gutter-both min-h-0 flex-1 overflow-x-hidden overscroll-y-contain"
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={
          <KinPresenceLine presence={props.presence} stop={stopState} onStop={onStop} />
        }
      />
      <div className="relative mx-auto w-full max-w-3xl px-4 pb-4">
        {unseen > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-3">
            <Button
              size="sm-pill"
              variant="glass"
              className="pointer-events-auto"
              aria-label={`${unseen} new ${unseen === 1 ? "message" : "messages"}. Scroll to the latest.`}
              onClick={jumpToEnd}
            >
              <ArrowDownIcon />
              New messages
            </Button>
          </div>
        ) : null}
        {notice === null ? null : (
          <p role="status" className="pb-2 text-center text-xs text-muted-foreground">
            {notice}
          </p>
        )}
        <KinComposer
          draftKey={draftKey}
          environmentId={props.environmentId}
          recipient={props.title}
          textareaRef={composerRef}
          onSend={sendText}
        />
      </div>
      <ExpandedImageDialogHost threadKey={previewKey} />
    </div>
  );
}

/**
 * What the lead is doing, in one line under the feed. Its row keeps its height when empty, so a
 * reply landing never shifts the feed. Static text: it changes on 15 s ticks, never animates.
 */
function KinPresenceLine(props: {
  readonly presence: KinPresence | undefined;
  readonly onStop: (() => void) | null;
  readonly stop: StopState;
}) {
  const now = useKinPresenceNow(kinPresenceNeedsClock(props.presence));
  const line = kinPresenceLine(props.presence, now);
  const timerStart = kinPresenceTimerStart(props.presence);
  const { onStop } = props;
  const stoppable = line?.stalled === true && onStop !== null;
  return (
    <div className="mx-auto flex h-9 w-full max-w-3xl items-center gap-2 px-5 text-muted-foreground text-xs">
      <p role="status" aria-live="polite" className="truncate">
        {line === null ? "" : line.text}
      </p>
      {timerStart === null ? null : (
        // The timer ticks on its own; screen readers hear the presence text, not every second.
        <span aria-hidden="true">
          <WorkingTimer createdAt={timerStart} />
        </span>
      )}
      {stoppable ? (
        <>
          {props.stop === "idle" ? null : (
            <span role={props.stop === "failed" ? "alert" : undefined}>
              {props.stop === "failed" ? "Couldn't stop" : "Stopping…"}
            </span>
          )}
          <StopGenerationButton
            size="compact"
            label={props.stop === "failed" ? "Try stopping again" : "Stop"}
            tooltip={props.stop === "failed" ? "Try again" : "Stop"}
            disabled={props.stop === "stopping"}
            onClick={onStop}
          />
        </>
      ) : null}
    </div>
  );
}

/** First run in the owner's chat with their lead: what it does and a few asks to start with. */
function KinIntro(props: {
  readonly agentName: string;
  readonly charter: string | null;
  readonly onSend: (text: string) => void;
  readonly onStart: (text: string) => void;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>Say hello to {props.agentName}</EmptyTitle>
        <EmptyDescription>
          {props.charter ??
            `Ask for what you need in plain words. ${props.agentName} replies here, and asks you when a decision is yours.`}
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        {KIN_INTRO_PROMPTS.map((prompt) =>
          prompt.send ? (
            <Button
              key={prompt.text}
              size="sm"
              variant="outline"
              title={`Sends this to ${props.agentName}`}
              onClick={() => props.onSend(prompt.text)}
            >
              {prompt.text}
            </Button>
          ) : (
            <Button
              key={prompt.text}
              size="sm"
              variant="outline"
              aria-label={`${prompt.text.trimEnd()}, finish it yourself`}
              onClick={() => props.onStart(prompt.text)}
            >
              {prompt.text.trimEnd()}…
            </Button>
          ),
        )}
      </div>
    </Empty>
  );
}

const lengthFormat = new Intl.NumberFormat();
const noop = () => {};

/**
 * The chat's text box. A send goes to the outbox, which shows it at once and delivers it when the
 * host is reachable. Enter sends; Shift+Enter adds a line.
 */
function KinComposer(props: {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
  readonly recipient: string;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly onSend: (body: string, attachments: ReadonlyArray<KinAttachment>) => Promise<boolean>;
}) {
  const { draftKey, environmentId, recipient, textareaRef, onSend } = props;
  const atom = kinDraftAtom(draftKey);
  const text = useAtomValue(atom);
  const full = useAtomValue(kinOutbox.fullAtom(environmentId));
  const files = useKinComposerAttachments({ environmentId, draftKey });
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const length = text.trim().length;
  const tooLong = length > KIN_MESSAGE_MAX_LENGTH;
  const hasContent = length > 0 || files.count > 0;
  const canSend = hasContent && !tooLong && !full && files.blockReason === null && !sending;
  const hint = tooLong
    ? `Too long to send: ${lengthFormat.format(length)} of ${lengthFormat.format(KIN_MESSAGE_MAX_LENGTH)} characters.`
    : full
      ? "Too many unsent messages. Wait for them to go out."
      : files.blockReason;
  const notice = hint ?? files.refusal;

  const send = async () => {
    const drafted = appAtomRegistry.get(atom);
    const body = drafted.trim();
    if (body.length > KIN_MESSAGE_MAX_LENGTH) return;
    setSending(true);
    // `deliver` rejects only if a rejection escapes the outbox; the button must come back either way.
    await deliver(drafted, body).catch(() => undefined);
    setSending(false);
  };

  const deliver = async (drafted: string, body: string) => {
    // The text stays in the box while files upload, so a failed upload loses nothing.
    const settled = await files.settle();
    if (settled._tag === "blocked") return;
    if (body.length === 0 && settled.attachments.length === 0) return;
    if (!(await onSend(body, settled.attachments))) return;
    // Keeps anything typed while the files were uploading.
    const typed = appAtomRegistry.get(atom);
    appAtomRegistry.set(atom, typed.startsWith(drafted) ? typed.slice(drafted.length) : typed);
    files.clear();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (!files.canAttach || pasted.length === 0) return;
    const plainText = event.clipboardData.getData("text/plain");
    if (!shouldHandleComposerAttachmentPaste({ files: pasted, plainText })) return;
    event.preventDefault();
    void files.add(pasted);
  };

  const dropsFiles = (event: DragEvent<HTMLFormElement>) =>
    files.canAttach && event.dataTransfer.types.includes("Files");

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) void send();
  };

  return (
    <div className="flex flex-col gap-1">
      {notice === null ? null : (
        <p role="alert" className="px-1 text-xs text-destructive-foreground">
          {notice}
        </p>
      )}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <form
              className={cn(
                dragOver && "rounded-[inherit] bg-accent/45 ring-1 ring-inset ring-primary/70",
              )}
              onSubmit={(event) => {
                event.preventDefault();
                if (canSend) void send();
              }}
              onDragOver={(event) => {
                if (!dropsFiles(event)) return;
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDragOver(false);
              }}
              onDrop={(event) => {
                if (!dropsFiles(event)) return;
                event.preventDefault();
                setDragOver(false);
                void files.add(Array.from(event.dataTransfer.files));
                textareaRef.current?.focus();
              }}
            >
              <KinComposerAttachmentStrip
                environmentId={environmentId}
                draftKey={draftKey}
                state={files}
              />
              <div className="px-1 pt-2.5 sm:pt-3">
                <Textarea
                  unstyled
                  ref={textareaRef}
                  rows={2}
                  value={text}
                  aria-label={`Message ${recipient}`}
                  placeholder={`Message ${recipient}`}
                  onChange={(event) => appAtomRegistry.set(atom, event.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                />
              </div>
              <div className="flex items-center justify-between px-2 pb-2">
                <div className="flex items-center">
                  {files.canAttach ? (
                    <ComposerAttachButton
                      addComposerAttachments={(picked) => files.add(picked)}
                      focusComposer={() => textareaRef.current?.focus()}
                    />
                  ) : null}
                </div>
                <ComposerPrimaryActions
                  compact={false}
                  canOperateThread
                  pendingAction={null}
                  isRunning={false}
                  canInterrupt={false}
                  isSendBusy={sending}
                  sendDisabledReason={hint}
                  isEnvironmentUnavailable={false}
                  isPreparingWorktree={false}
                  hasSendableContent={hasContent}
                  onPreviousPendingQuestion={noop}
                  onInterrupt={noop}
                />
              </div>
            </form>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
