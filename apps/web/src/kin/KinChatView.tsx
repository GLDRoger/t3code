import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { KIN_PEOPLE_CHAT } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { kinAwayLine } from "@t3tools/client-runtime/kin/kinAway";
import { openKinProfile } from "./KinProfileSheet";
import { KIN_HOST_OFFLINE, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinOwnsDirectChat } from "@t3tools/client-runtime/kin/kinClearChat";
import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { resolveTimelineIsAtEnd } from "../components/chat/MessagesTimeline.logic";
import {
  attachTimelineViewport,
  navigationReleasesFollow,
} from "../components/chat/timelineViewport";
import {
  kinChatGoneCopy,
  initialKinPaging,
  kinActivePaging,
  kinChatScreenState,
  kinChatStatusLine,
  kinFeedViewer,
  kinMarkReadRearms,
  kinSeqToMarkRead,
  kinUnreadToMark,
  latestKinSeq,
  type KinChatScreenState,
  type KinFeedRow,
  type KinFeedViewer,
  type KinPaging,
  KIN_CHAT_COPY,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  initialKinFeedFollow,
  kinRepinsEnd,
  resolveKinFeedFollow,
  type KinFeedFollowEvent,
} from "@t3tools/client-runtime/kin/kinFeedFollow";
import {
  applyKinChatHistory,
  type KinChatState,
  type KinInboxState,
} from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  kinIntroSendsTo,
  KIN_INTRO_COUNTRY,
  KIN_INTRO_PROMPTS,
  KIN_INTRO_START_HINT,
} from "@t3tools/client-runtime/kin/kinIntro";
import { kinIntroSetUpLine } from "@t3tools/client-runtime/kin/kinSetUp";
import {
  kinHeldCardAgent,
  kinRetiredChatLine,
  kinRetiredEmptyChat,
  kinRetiredGroupLine,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import { kinChatReadOnlyLine } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import {
  kinPresenceLine,
  kinPresenceNeedsClock,
  kinPresenceTimerStart,
} from "@t3tools/client-runtime/kin/kinLive";
import { KIN_MESSAGE_MAX_LENGTH, KIN_COMPOSER_COPY } from "@t3tools/client-runtime/kin/kinOutbox";
import {
  kinReactionChips,
  kinReactionToggle,
  kinViewerMemberId,
} from "@t3tools/client-runtime/kin/kinReactions";
import {
  kinAgentAvatar,
  kinChatPinned,
  kinStaleNotice,
  type KinAvatarView,
} from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinSynced } from "@t3tools/client-runtime/kin/kinStreams";
import {
  kinDocAskPlaceholder,
  kinDocRefLabel,
  kinPendingRefAtom,
  kinPendingRefKey,
} from "@t3tools/client-runtime/kin/kinDocs";
import {
  KinChatId,
  KinOrgId,
  type EnvironmentId,
  type KinAttachment,
  type KinChatMember,
  type KinChatMembersResult,
  type KinLeadsListResult,
  type KinMessageRef,
  type KinPresence,
  type KinReactionEmoji,
  type KinWakeupId,
  kinWhenFormat,
} from "@t3tools/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { ArrowDownIcon, ArrowLeftIcon, ChevronUpIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { shouldHandleComposerAttachmentPaste } from "../components/chat/composerAttachmentFiles";
import { ExpandedImageDialogHost } from "../components/chat/ExpandedImageDialog";
import { ComposerPrimaryActions } from "../components/chat/ComposerPrimaryActions";
import { ComposerSurface } from "../components/chat/ComposerSurface";
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
import { hasDesktopWindowChrome } from "./kinDesktopWindow";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinStopButton, KinWorkingTimer } from "./KinPresenceControls";
import {
  KinComposerAttachmentStrip,
  kinPreviewKey,
  useKinComposerAttachments,
  KinAttachButton,
} from "./KinComposerAttachments";
import { KinRestoreAgent, type KinAgentTarget } from "./KinAgentRetire";
import { kinClient } from "./kinClient";
import { KinGroupSheet } from "./KinGroupSheet";
import { kinProfileRequestAtom } from "./kinTeamForm";
import { KinLeadSheet, type KinLeadAbout } from "./KinLeadSheet";
import {
  kinApplyMention,
  kinMemberNames,
  kinMentionQuery,
  kinMentionsIn,
  type KinMentionCandidate,
} from "@t3tools/client-runtime/kin/kinGroups";
import { deliverKinOutbox, kinLocalPreviews, kinOutbox, startKinOutbox } from "./kinOutbox";
import {
  KIN_LAND_MARK_MS,
  kinChatFeedView,
  kinChatReads,
  kinChatScreen,
  type KinChatRow,
} from "@t3tools/client-runtime/kin/kinChatScreen";
import {
  formatKinMessageTime,
  KinDayRow,
  KinDocRefMark,
  KinDraftRow,
  KinFoldRow,
  KinRelayRow,
  KinMessageRow,
  KinPendingRow,
  KinSystemRow,
} from "./KinMessageRows";
import { useKinPresenceNow, useNowMinuteMs } from "./useKinClock";
import { KinStandInLine } from "./KinStandInLine";
import { KIN_UNSENT_ATTRIBUTE } from "./KinUpdatedLine";
import { kinAccessCopy } from "./kinTeammateMark";
import { useKinHostAt } from "./useKinHost";
import { useKinCountryNeeded } from "./useKinMoney";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import { useKinWhatWeSellAnswer } from "./useKinDocs";
import { kinStopNotice } from "@t3tools/client-runtime/kin/kinStop";
import { useKinStopLine } from "./useKinStop";
import { openKinSettings } from "./kinSettingsAddress";
import { useKinProfiles } from "./kinPictures";
import { kinDraftAtom, kinDraftKey, restoreDraft } from "./kinDraft";
import { Skeleton } from "../components/ui/skeleton";
import { runKinCommand } from "@t3tools/client-runtime/kin/kinRunCommand";

type ChatResult = AsyncResult.AsyncResult<KinSynced<KinChatState>, unknown> | null;
type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;
const NO_RETIRED_AGENTS: ReadonlySet<string> = new Set();
type LeadsResult = AsyncResult.AsyncResult<KinLeadsListResult, unknown> | null;
const noLeadsAtom: Atom.Atom<LeadsResult> = Atom.make<LeadsResult>(null);
type GroupResult = AsyncResult.AsyncResult<KinChatMembersResult, unknown> | null;
const noGroupAtom: Atom.Atom<GroupResult> = Atom.make<GroupResult>(null);
const noChatAtom: Atom.Atom<ChatResult> = Atom.make<ChatResult>(null);
const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);
const decodeChatId = Schema.decodeUnknownOption(KinChatId);

// Mirrors the host's reactable cards; the host still refuses the rest.
const REACTABLE_WIDGETS = new Set(["choice", "task", "routine"]);

export function KinChatView(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly chatId: string;
  /** A message a notification opened the chat on, brought into view once it has loaded. */
  readonly message?: string | undefined;
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
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(props.environmentId));
  const nowMs = useNowMinuteMs();
  const chats = inbox?._tag === "Success" ? inbox.value.value.chats : null;
  const reads = kinChatReads({ chatId, chats, canRestore });
  const leadsAtom: Atom.Atom<LeadsResult> =
    environmentId === null || reads.orgId === null || reads.leads === null
      ? noLeadsAtom
      : reads.leads === "agents"
        ? kinClient.agents({ environmentId, orgId: reads.orgId })
        : kinClient.leads({ environmentId, input: { orgId: reads.orgId } });
  const leads = useAtomValue(leadsAtom);
  // A group's row carries only the viewer's own member; who else is in it is read by name.
  const groupAtom: Atom.Atom<GroupResult> =
    environmentId === null || chatId === null || !reads.group
      ? noGroupAtom
      : kinClient.chatMembers({ environmentId, input: { chatId } });
  const groupResult = useAtomValue(groupAtom);
  // What was last read stays up while a change is read again.
  const group = groupResult === null ? null : Option.getOrNull(AsyncResult.value(groupResult));
  const screen = kinChatScreen({
    chatId,
    orgId: props.orgId,
    viewer,
    chats,
    canRestore,
    namesKnown:
      host._tag === "host" && (host.probe._tag === "ready" || host.probe._tag === "noIdentity"),
    nowMs,
    leads: leads?._tag === "Success" ? leads.value : null,
    group,
  });
  const { summary, teamRoomId, ownedAgentId, lead, contact, isGroup, pairWith, muted, title } =
    screen;
  const about: KinLeadAbout | null =
    lead !== null ? { kind: "own", lead } : contact !== null ? { kind: "contact", contact } : null;
  const restorable: KinAgentTarget | null =
    screen.retired?.restorable == null || environmentId === null
      ? null
      : {
          environmentId,
          orgId: screen.retired.restorable.orgId,
          agentId: screen.retired.restorable.agentId,
          name: screen.retired.restorable.name,
        };
  const [profileHeld, setProfileHeld] = useState(false);
  // A teammate's row on the Team page leads here with the lead's details already open.
  const profileRequested = useAtomValue(kinProfileRequestAtom) === chatId && chatId !== null;
  const profileOpen = profileHeld || profileRequested;
  const setProfileOpen = (open: boolean) => {
    setProfileHeld(open);
    if (!open && profileRequested) appAtomRegistry.set(kinProfileRequestAtom, null);
  };
  const profiles = useKinProfiles(
    pairWith === null ? null : environmentId,
    summary === undefined ? null : summary.orgId,
  );
  const { avatar } = screen;

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
  const pairProfile =
    pairWith === null || profiles === null
      ? undefined
      : Option.getOrNull(AsyncResult.value(profiles))?.profiles.find(
          (profile) => profile.personId === pairWith,
        );
  const away = pairProfile === undefined ? null : kinAwayLine(pairProfile, { mine: false });
  // A chat between people goes on while agents are stopped.
  const stopLine = useKinStopLine(
    environmentId === null || summary === undefined || pairWith !== null
      ? null
      : { environmentId, orgId: summary.orgId },
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <KinChatHeader
        title={title}
        avatar={avatar}
        tasks={
          tasks ??
          (pairWith === null
            ? null
            : away === null
              ? KIN_PEOPLE_CHAT.privacy
              : KIN_CHAT_COPY.awayHolds(away))
        }
        muted={muted}
        onOpenProfile={
          pairWith !== null && environmentId !== null && summary !== undefined
            ? () => openKinProfile({ environmentId, orgId: summary.orgId, personId: pairWith })
            : about === null && group === null
              ? null
              : () => setProfileOpen(true)
        }
      />
      {group === null ||
      environmentId === null ||
      summary === undefined ||
      pairWith !== null ? null : (
        <KinGroupSheet
          open={profileOpen}
          onOpenChange={setProfileOpen}
          group={group}
          environmentId={environmentId}
          orgId={summary.orgId}
          personId={viewer.personId}
          muted={muted}
          retiredAgents={viewer.retiredAgents ?? NO_RETIRED_AGENTS}
        />
      )}
      {about === null || avatar === null || environmentId === null || chatId === null ? null : (
        <KinLeadSheet
          open={profileOpen}
          onOpenChange={setProfileOpen}
          about={about}
          avatar={avatar}
          environmentId={environmentId}
          chatId={chatId}
          muted={muted}
          pinned={
            // The main agent's chat is always on top, so it offers no pin.
            summary === undefined ||
            viewer.personId === null ||
            (about.kind === "own" ? about.lead.agentId : about.contact.agentId) ===
              (leads?._tag === "Success" ? leads.value.teamAgentId : undefined)
              ? null
              : kinChatPinned(summary, new Set([viewer.personId]))
          }
          activeAgents={screen.activeAgents}
          ownsChat={
            summary !== undefined &&
            kinOwnsDirectChat(summary.kind, summary.members, viewer.personId)
          }
        />
      )}
      {state._tag === "ready" ? (
        <KinChatFeed
          // Paging, folds and follow belong to one chat.
          key={`${state.environmentId}:${props.chatId}`}
          orgId={props.orgId}
          title={title ?? "Chat"}
          environmentId={state.environmentId}
          chatId={chatId ?? (props.chatId as KinChatId)}
          agentName={screen.agentName}
          landOn={props.message ?? null}
          chat={state.chat}
          connected={state.connected}
          offline={state.offline}
          error={state.error}
          onRetry={retry}
          viewer={
            isGroup ? { ...viewer, memberNames: kinMemberNames(group?.members ?? null) } : viewer
          }
          mentionable={screen.mentionable}
          unread={kinUnreadToMark(summary)}
          presence={presence}
          stopLead={
            summary === undefined ||
            ownedAgentId === null ||
            !canInterrupt ||
            screen.retired !== null
              ? null
              : (wakeupId) =>
                  runKinCommand(appAtomRegistry, kinClient.leadInterrupt, {
                    environmentId: state.environmentId,
                    input: { orgId: summary.orgId, wakeupId: wakeupId as KinWakeupId },
                  }).then((result) => result._tag === "Success")
          }
          charter={screen.charter}
          setsUp={screen.setsUp}
          members={group?.members ?? summary?.members ?? []}
          direct={summary?.kind === "direct"}
          teamRoomId={teamRoomId}
          ownsLead={ownedAgentId !== null}
          about={screen.about}
          readOnly={
            !screen.readOnly
              ? null
              : kinChatReadOnlyLine(
                  pairWith === null
                    ? {
                        kind: "agent",
                        name: screen.agentName,
                      }
                    : { kind: "person", name: pairProfile?.displayName ?? null },
                )
          }
          retired={screen.retired === null ? null : { name: screen.retired.name, restorable }}
          groupNotice={kinStopNotice(
            stopLine,
            screen.silentAnswerer === null
              ? null
              : kinRetiredGroupLine(screen.silentAnswerer, canRestore),
          )}
        />
      ) : (
        <KinChatStateView state={state} onRetry={retry} />
      )}
    </div>
  );
}

/** Who the chat is with, and their open tasks. What the lead is doing right now reads under the feed. */
function KinChatHeader(props: {
  /** Null while a direct chat's agent isn't named yet. */
  readonly title: string | null;
  readonly avatar: KinAvatarView | null;
  readonly tasks: string | null;
  readonly muted: boolean;
  /** Opens the lead's profile; null for a chat that has none to show. */
  readonly onOpenProfile: (() => void) | null;
}) {
  const subtitle = props.tasks;
  const identity = (
    <>
      {props.avatar === null ? null : <KinAvatar avatar={props.avatar} size="sm" />}
      <WorkspaceBreadcrumb ariaLabel="Chat" className="shrink">
        <WorkspaceBreadcrumbItem current>
          <h1 className="min-w-0">
            <WorkspaceBreadcrumbText>
              {props.title ?? <Skeleton className="inline-block h-3.5 w-24 align-middle" />}
            </WorkspaceBreadcrumbText>
          </h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </>
  );
  return (
    <WorkspacePageHeader electron={hasDesktopWindowChrome}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={KIN_CHAT_COPY.back}
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
          aria-label={`${props.title ?? "Chat"}: open details`}
          className="-mx-1.5 flex min-w-0 shrink items-center gap-3 rounded-md px-1.5 py-1 outline-none ring-ring [-webkit-app-region:no-drag] hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
          onClick={props.onOpenProfile}
        >
          {identity}
        </button>
      )}
      {props.muted ? <span className="sr-only">Muted</span> : null}
      {subtitle === null ? null : (
        <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-tight text-muted-foreground sm:truncate sm:text-sm sm:leading-normal">
          {subtitle}
        </p>
      )}
    </WorkspacePageHeader>
  );
}

const STATE_COPY: Record<
  Exclude<KinChatScreenState["_tag"], "ready" | "loading" | "error" | "gone">,
  { readonly title: string; readonly detail: string }
> = {
  offline: {
    title: KIN_HOST_OFFLINE,
    detail: "This chat loads when the Kin environment reconnects.",
  },
  noHost: {
    title: "Kin isn't set up on this environment",
    detail: "Connect to a server that runs Kin.",
  },
  unpaired: {
    title: "This browser isn't connected to that server",
    detail: KIN_DEVICE_COPY.pairToOpen,
  },
  unauthorized: {
    title: KIN_DEVICE_COPY.cantReadChats("browser"),
    detail: KIN_DEVICE_COPY.pairAgain,
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
      ? kinChatGoneCopy(state.reason)
      : kinAccessCopy(state._tag, STATE_COPY[state._tag]);
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const offlineTime = kinWhenFormat("time");

type StopState = "idle" | "stopping" | "failed";

function KinChatFeed(props: {
  readonly orgId: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly chatId: KinChatId;
  readonly agentName: string | null;
  readonly landOn: string | null;
  readonly chat: KinSynced<KinChatState>;
  readonly connected: boolean;
  /** Known unreachable, not just still on its first connection attempt. */
  readonly offline: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly viewer: KinFeedViewer;
  readonly unread: number | null;
  readonly presence: KinPresence | undefined;
  readonly stopLead: ((wakeupId: string) => Promise<boolean>) | null;
  /** What the owner wrote this lead is for; the intro shows it before the first message. */
  readonly charter: string | null;
  /** The viewer's own Chief of staff, whose intro may name the company's answer. */
  readonly setsUp: boolean;
  readonly members: ReadonlyArray<KinChatMember>;
  /** A group's leads, which the composer offers on `@`. */
  readonly mentionable: ReadonlyArray<KinMentionCandidate>;
  readonly direct: boolean;
  /** The org's Team room, where a discussion's outcome links to. */
  readonly teamRoomId: KinChatId | null;
  readonly ownsLead: boolean;
  /** What the owner of someone else's lead wrote for the people it talks to. */
  readonly about: string | null;
  /** The viewer reads this chat and can no longer write in it: the line saying so. */
  readonly readOnly: string | null;
  /** This direct chat's agent is retired: its history stays, with Restore where the owner may. */
  readonly retired: { readonly name: string; readonly restorable: KinAgentTarget | null } | null;
  /** Said over the composer of a group whose answering agent is retired. */
  readonly groupNotice: string | null;
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
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const feed = kinChatFeedView({
    chatId: props.chatId,
    live,
    earlier: paging.earlier,
    exhausted: paging.exhausted,
    outbox,
    viewer: props.viewer,
    expandedRuns,
    dayStart,
    teamRoomId: props.teamRoomId,
    direct: props.direct,
    formatTime: formatKinMessageTime,
    follow,
    landOn: props.landOn,
    ownsLead: props.ownsLead,
    agentName: props.agentName,
    retired: props.retired !== null,
    readOnly: props.readOnly !== null,
  });
  const { streamed, widgets, pending, rows, display, landIndex, followsEnd, unseen } = feed;
  const echoedKey = feed.echoed.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frees outbox entries once the stream carries their message
  useEffect(() => {
    if (echoedKey !== "") kinOutbox.forgetEchoed(new Set(echoedKey.split("\n")));
  }, [echoedKey]);
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
      ? (props.viewer.agentNames.get(member.principal.agentId) ?? "Agent")
      : (props.viewer.memberNames?.get(memberId) ?? (member.role === "owner" ? "Owner" : "Member"));
  };
  const { landOn } = props;
  const landed = useRef<string | null>(null);
  // The message a row opened, tinted a moment once it has loaded so the eye lands on it.
  const [markDone, setMarkDone] = useState<string | null>(null);

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

  const { earlierPage, latestSeq, showIntro } = feed;
  const loading = paging.request !== null;
  const canLoadEarlier = props.connected && earlierPage !== null;

  const { connected, unread } = props;
  const focused = typeof document === "undefined" || document.visibilityState === "visible";
  const markRead = (seq: number) =>
    runKinCommand(appAtomRegistry, kinClient.markRead, {
      environmentId: props.environmentId,
      input: { chatId: props.chatId, seq },
    }).then((result) => result._tag === "Success");
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

  // Read by scroll listeners in the same frame as the person's input, before React renders.
  const followRef = useRef(follow);
  const transition = (event: KinFeedFollowEvent) => {
    const next = resolveKinFeedFollow(followRef.current, event);
    if (next === followRef.current) return;
    followRef.current = next;
    setFollow(next);
  };

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
          : { ...current, request: null, error: KIN_CHAT_COPY.earlierFailed },
      );
      transition({
        type: "page-settled",
        added: Exit.isSuccess(exit) && exit.value.messages.length > 0,
      });
    });
  };

  const seekBefore = feed.landPage?.beforeSeq ?? null;
  const pageFailed = paging.error !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads back, a page at a time, to the message the chat was opened on; stops at the chat's start or a failed page
  useEffect(() => {
    if (seekBefore === null || pageFailed || loading || !canLoadEarlier) return;
    if (landed.current === landOn) return;
    loadEarlier();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loadEarlier is rebuilt each render and reads the page these name.
  }, [seekBefore, pageFailed, loading, canLoadEarlier, landOn, landed]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list, outside React, to the message the chat was opened on, once it has loaded
  useEffect(() => {
    if (landOn === null || landIndex < 0 || landed.current === landOn) return;
    // Let go of the end first, so the list's pin to its end can't take the reader back down.
    if (followsEnd) return transition({ type: "land" });
    landed.current = landOn;
    void listRef.current?.scrollToIndex({ index: landIndex, animated: false, viewPosition: 0.3 });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- transition reads only refs and the stable setFollow.
  }, [landIndex, landOn, followsEnd, listRef, landed]);
  const marked = landOn !== null && landIndex >= 0 && markDone !== landOn;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: the mark on the message a row opened lasts a moment, then goes
  useEffect(() => {
    if (!marked || landOn === null) return;
    const timer = setTimeout(() => setMarkDone(landOn), KIN_LAND_MARK_MS);
    return () => clearTimeout(timer);
  }, [marked, landOn]);

  const checkEnd = () => {
    const isAtEnd = listRef.current?.getState().isAtEnd ?? true;
    // The list skips its own re-pin while its opening scroll runs, so a message landing then
    // would leave it short of the end; following, we pin it ourselves.
    if (kinRepinsEnd(followRef.current, isAtEnd))
      void listRef.current?.scrollToEnd({ animated: false });
    transition({ type: "end-check", isAtEnd });
    if (isAtEnd) transition({ type: "seen", seq: reading.current.latestSeq });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hears the person's own scrolling on the list's DOM node, and the list's re-pin to its end
  useEffect(() => {
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (!list || !(scrollNode instanceof HTMLElement)) return;
    // The coding thread's own input listeners: only these let go of the end.
    const viewport = attachTimelineViewport(scrollNode);
    const unsubscribe = viewport.subscribe((navigation) => {
      const state = list.getState();
      const releases = navigationReleasesFollow(navigation, {
        contentScrollsUp: () => state.scroll > 0,
        awayFromEnd: () => resolveTimelineIsAtEnd(state) === false,
      });
      if (releases) transition({ type: "navigated", seq: reading.current.latestSeq });
    });
    const unlisten = list.getState().listen("isAtEnd", checkEnd);
    return () => {
      unlisten();
      unsubscribe();
      viewport.dispose();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- checkEnd and transition read only refs and the stable setFollow.
  }, []);

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

  const sendText = async (
    body: string,
    attachments: ReadonlyArray<KinAttachment> = [],
    images: ReadonlyArray<Blob> = [],
    refs: ReadonlyArray<KinMessageRef> = [],
  ) => {
    const queued = await kinOutbox.enqueue({
      environmentId: props.environmentId,
      chatId: props.chatId,
      body,
      ...(attachments.length > 0 ? { attachments } : {}),
      // Read from the text, so a resent message asks the lead it named the first time.
      mentions: kinMentionsIn(body, props.mentionable),
      ...(refs.length > 0 ? { refs } : {}),
    });
    if (queued._tag !== "queued") return false;
    kinLocalPreviews.remember(
      queued.entry.clientMessageId,
      images.map((image) => URL.createObjectURL(image)),
    );
    jumpToEnd();
    void deliverKinOutbox();
    return true;
  };

  const renderMessage = (
    item: Extract<KinFeedRow, { readonly type: "message" }>,
    group?: Extract<KinChatRow, { readonly type: "cards" }>,
  ) => {
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
      (message.widgetId === null || (widget !== undefined && REACTABLE_WIDGETS.has(widget.type)));
    return (
      <KinMessageRow
        row={item}
        head={shown?.head ?? null}
        direct={props.direct}
        widget={widget}
        environmentId={props.environmentId}
        viewerPersonId={props.viewer.personId}
        firstName={props.viewer.firstName ?? null}
        heldFor={kinHeldCardAgent(message.author, props.viewer, props.retired?.name ?? null)}
        readOnly={props.readOnly !== null}
        orgId={props.orgId}
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
        connected={props.connected}
        {...(group === undefined
          ? {}
          : {
              group: {
                question:
                  group.question?.message.widgetId == null
                    ? undefined
                    : widgets.get(group.question.message.widgetId),
                tasks: group.tasks.map((task) =>
                  task.message.widgetId === null ? undefined : widgets.get(task.message.widgetId),
                ),
              },
            })}
      />
    );
  };

  const renderItem = ({ item }: { readonly item: KinChatRow }) => {
    switch (item.type) {
      case "message":
        return renderMessage(item);
      case "cards":
        return renderMessage(item.first, item);
      case "system": {
        const { retry } = item;
        // An unsent message is already a retry in flight.
        return (
          <KinSystemRow
            body={item.text}
            onRetry={retry === null || pending.length > 0 ? null : () => void sendText(retry)}
            open={
              item.open === null
                ? null
                : { target: item.open, environmentId: props.environmentId, orgId: props.orgId }
            }
            discussion={
              item.discussionId === null || props.teamRoomId === null
                ? null
                : {
                    discussionId: item.discussionId,
                    teamRoomId: props.teamRoomId,
                    environmentId: props.environmentId,
                    orgId: props.orgId,
                  }
            }
          />
        );
      }
      case "fold":
        return <KinFoldRow row={item} onToggle={() => toggleRun(item.runId)} />;
      case "relay":
        return (
          <KinRelayRow
            row={item}
            environmentId={props.environmentId}
            orgId={props.orgId}
            teamRoomId={props.teamRoomId}
          />
        );
      case "pending":
        return (
          <KinPendingRow
            entry={item.entry}
            connected={props.connected}
            environmentId={props.environmentId}
            orgId={props.orgId}
            previewKey={previewKey}
            continues={item.continues}
            onEdit={() =>
              void kinOutbox.discard(item.entry.clientMessageId).then((body) => {
                if (body === null) return;
                kinLocalPreviews.forget(item.entry.clientMessageId);
                restoreDraft(draftKey, body);
                composerRef.current?.focus();
              })
            }
            onDiscard={() =>
              void kinOutbox.discard(item.entry.clientMessageId).then((body) => {
                if (body !== null) kinLocalPreviews.forget(item.entry.clientMessageId);
              })
            }
          />
        );
      case "day":
        return <KinDayRow label={item.label} />;
      case "draft":
        return (
          <KinDraftRow
            row={item}
            environmentId={props.environmentId}
            orgId={props.orgId}
            direct={props.direct}
          />
        );
    }
  };

  const notice =
    kinStaleNotice(
      {
        connected: props.connected,
        offline: props.offline,
        live: props.chat.live,
        savedAt: props.chat.savedAt,
      },
      "idle",
      (date) => offlineTime.format(date),
    )?.message ?? null;

  const intro =
    showIntro && props.agentName !== null ? (
      <KinIntro
        environmentId={props.environmentId}
        orgId={props.orgId}
        agentName={props.agentName}
        charter={props.charter}
        setsUp={props.setsUp}
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
            ? KIN_CHAT_COPY.loadingEarlier
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

  const retiredEmpty = props.retired === null ? null : kinRetiredEmptyChat(props.retired.name);
  const empty = feed.empty
    ? (intro ?? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              {retiredEmpty !== null
                ? retiredEmpty.title
                : props.agentName === null
                  ? KIN_CHAT_COPY.none
                  : KIN_CHAT_COPY.sayHello(props.agentName)}
            </EmptyTitle>
            <EmptyDescription>
              {retiredEmpty !== null
                ? retiredEmpty.detail
                : props.agentName === null
                  ? KIN_CHAT_COPY.empty
                  : (props.about ?? "Your first message starts the chat.")}
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
        renderItem={({ item, index }: { readonly item: KinChatRow; readonly index: number }) =>
          marked && index === landIndex ? (
            <div className="rounded-lg bg-primary/10">{renderItem({ item })}</div>
          ) : (
            renderItem({ item })
          )
        }
        // Both reach rows only through renderItem, which the list doesn't watch.
        extraData={[marked, streamed.widgets, streamed.reactions, canReact, display]}
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
          <KinPresenceLine
            environmentId={props.environmentId}
            presence={props.presence}
            stop={stopState}
            onStop={onStop}
          />
        }
      />
      <div className="relative mx-auto w-full max-w-3xl px-4 pb-4">
        {unseen > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-3">
            <Button
              size="sm-pill"
              variant="glass"
              className="pointer-events-auto"
              aria-label={KIN_CHAT_COPY.unseen(unseen)}
              onClick={jumpToEnd}
            >
              <ArrowDownIcon />
              New messages
            </Button>
          </div>
        ) : null}
        {notice === null ? (
          <KinStandInLine
            environmentId={props.environmentId}
            className="pb-2 text-center text-xs text-muted-foreground"
          />
        ) : (
          <p role="status" className="pb-2 text-center text-xs text-muted-foreground">
            {notice}
          </p>
        )}
        {props.groupNotice === null ? null : (
          <p role="status" className="pb-2 text-center text-xs text-muted-foreground">
            {props.groupNotice}
          </p>
        )}
        {feed.composer === "retired" && props.retired !== null ? (
          <div role="status" className="flex flex-col items-center gap-2 py-3">
            <p className="text-center text-sm text-muted-foreground">
              {kinRetiredChatLine(props.retired.name, props.retired.restorable !== null)}
            </p>
            {props.retired.restorable === null ? null : (
              <KinRestoreAgent agent={props.retired.restorable} />
            )}
          </div>
        ) : feed.composer === "read-only" ? (
          <p role="status" className="py-3 text-center text-sm text-muted-foreground">
            {props.readOnly}
          </p>
        ) : (
          <KinComposer
            draftKey={draftKey}
            environmentId={props.environmentId}
            pendingRefKey={kinPendingRefKey(props.environmentId, props.chatId)}
            recipient={props.title}
            textareaRef={composerRef}
            onSend={sendText}
            mentionable={props.mentionable}
          />
        )}
      </div>
      <ExpandedImageDialogHost threadKey={previewKey} />
    </div>
  );
}

/**
 * What the lead is doing, with its pebble, in one line under the feed. Its row keeps its height
 * when empty, so a reply landing never shifts the feed. Static text: it changes on 15 s ticks.
 */
function KinPresenceLine(props: {
  readonly environmentId: EnvironmentId;
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
      {line === null || props.presence === undefined ? null : (
        <KinAvatar avatar={kinAgentAvatar(props.presence.agentId)} size="xs" />
      )}
      <p role="status" aria-live="polite" className="truncate">
        {line === null ? "" : line.text}
      </p>
      {timerStart === null ? null : (
        // The timer ticks on its own; screen readers hear the presence text, not every second.
        <span aria-hidden="true">
          <KinWorkingTimer createdAt={timerStart} environmentId={props.environmentId} />
        </span>
      )}
      {stoppable ? (
        <>
          {props.stop === "idle" ? null : (
            <span role={props.stop === "failed" ? "alert" : undefined}>
              {props.stop === "failed" ? "Couldn't stop" : "Stopping…"}
            </span>
          )}
          <KinStopButton
            label={props.stop === "failed" ? KIN_CHAT_COPY.stopAgain : "Stop"}
            tooltip={props.stop === "failed" ? KIN_RETRY : "Stop"}
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
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly agentName: string;
  readonly charter: string | null;
  readonly setsUp: boolean;
  readonly onSend: (text: string) => void;
  readonly onStart: (text: string) => void;
}) {
  const router = useRouter();
  const countryNeeded = useKinCountryNeeded(props);
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  const countryFirst = countryNeeded && ownerLevel;
  const answer = useKinWhatWeSellAnswer(
    { environmentId: props.environmentId, orgId: KinOrgId.make(props.orgId) },
    props.setsUp && ownerLevel,
  );
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{KIN_CHAT_COPY.sayHello(props.agentName)}</EmptyTitle>
        <EmptyDescription>
          {props.charter ??
            `Ask for what you need in plain words. ${props.agentName} replies here, and asks you when a decision is yours.`}
        </EmptyDescription>
        {typeof answer === "string" ? (
          <EmptyDescription>{kinIntroSetUpLine(props.agentName, answer)}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        {countryFirst ? (
          <Button size="sm" onClick={() => openKinSettings(router.history, "company")}>
            {KIN_INTRO_COUNTRY}
          </Button>
        ) : null}
        {KIN_INTRO_PROMPTS.map((prompt) =>
          prompt.send ? (
            <Button
              key={prompt.text}
              size="sm"
              variant="outline"
              title={kinIntroSendsTo(props.agentName)}
              onClick={() => props.onSend(prompt.text)}
            >
              {prompt.label}
            </Button>
          ) : (
            <Button
              key={prompt.text}
              size="sm"
              variant="outline"
              title={KIN_INTRO_START_HINT}
              onClick={() => props.onStart(prompt.text)}
            >
              {prompt.label}
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
  readonly onSend: (
    body: string,
    attachments: ReadonlyArray<KinAttachment>,
    images: ReadonlyArray<Blob>,
    refs: ReadonlyArray<KinMessageRef>,
  ) => Promise<boolean>;
  /** Where a doc section pointed at for this chat waits until it is sent. */
  readonly pendingRefKey: string;
  /** The group's leads, offered on `@`; a message that names one is answered by it. */
  readonly mentionable: ReadonlyArray<KinMentionCandidate>;
}) {
  const { draftKey, environmentId, recipient, textareaRef, onSend } = props;
  // Where the caret is, and the text the suggestions were last dismissed for.
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const atom = kinDraftAtom(draftKey);
  const text = useAtomValue(atom);
  const pendingAtom = kinPendingRefAtom(props.pendingRefKey);
  const pending = useAtomValue(pendingAtom);
  const full = useAtomValue(kinOutbox.fullAtom(environmentId));
  const files = useKinComposerAttachments({ environmentId, draftKey });
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const length = text.trim().length;
  const tooLong = length > KIN_MESSAGE_MAX_LENGTH;
  const hasContent = length > 0 || files.count > 0;
  const canSend = hasContent && !tooLong && !full && files.blockReason === null && !sending;
  const hint = tooLong
    ? KIN_COMPOSER_COPY.tooLong(
        lengthFormat.format(length),
        lengthFormat.format(KIN_MESSAGE_MAX_LENGTH),
      )
    : full
      ? KIN_COMPOSER_COPY.tooMany
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
    const held = appAtomRegistry.get(pendingAtom);
    if (!(await onSend(body, settled.attachments, settled.images, held === null ? [] : [held.ref])))
      return;
    if (appAtomRegistry.get(pendingAtom) === held) appAtomRegistry.set(pendingAtom, null);
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

  const mention = dismissed === text ? null : kinMentionQuery(text, caret, props.mentionable);
  // The highlighted suggestion, kept only for the query it was moved in.
  const mentionKey = mention === null ? "" : text.slice(mention.start, caret);
  const [moved, setMoved] = useState({ key: "", index: 0 });
  const activeMention =
    mention === null || moved.key !== mentionKey
      ? 0
      : Math.min(moved.index, mention.matches.length - 1);
  const mentionListId = useId();
  const pickMention = (name: string) => {
    if (mention === null) return;
    const next = kinApplyMention(text, mention.start, caret, name);
    appAtomRegistry.set(atom, next.text);
    setCaret(next.cursor);
    // The caret moves once React has written the new text into the box.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention !== null && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(text);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = mention.matches.length;
        const step = event.key === "ArrowDown" ? 1 : count - 1;
        setMoved({ key: mentionKey, index: (activeMention + step) % count });
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pickMention(mention.matches[activeMention]!.name);
        return;
      }
    }
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
      {mention === null ? null : (
        <div
          id={mentionListId}
          role="listbox"
          aria-label={KIN_COMPOSER_COPY.agentsYouCanAsk}
          className="flex flex-wrap gap-1.5 px-1"
        >
          {mention.matches.map((lead, index) => (
            <Button
              key={lead.memberId}
              id={`${mentionListId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeMention}
              size="xs"
              variant={index === activeMention ? "outline" : "ghost"}
              // Keeps the caret in the box, so the name lands where it was typed.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickMention(lead.name)}
            >
              <KinAvatar avatar={kinAgentAvatar(lead.agentId)} size="xs" />
              {lead.name}
            </Button>
          ))}
        </div>
      )}
      {pending === null ? null : (
        <div className="flex items-center gap-1 px-1">
          <KinDocRefMark label={kinDocRefLabel(pending.ref)} />
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Remove ${kinDocRefLabel(pending.ref)}`}
            onClick={() => appAtomRegistry.set(pendingAtom, null)}
          >
            <XIcon />
          </Button>
        </div>
      )}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <form
              className={cn(
                dragOver && "rounded-[inherit] bg-accent/45 ring-1 ring-inset ring-primary/70",
              )}
              {...(hasContent || sending ? { [KIN_UNSENT_ATTRIBUTE]: "" } : {})}
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
              {/* The thread composer's editor box, so both composers are one size. */}
              <div className="px-4 pt-3.5 pb-2 sm:pt-4">
                <textarea
                  className="-m-1 block field-sizing-content max-h-52 min-h-[calc(2lh+--spacing(2))] w-[calc(100%+--spacing(2))] resize-none overflow-y-auto bg-transparent p-1 text-sm leading-relaxed wrap-break-word text-foreground outline-none placeholder:text-placeholder"
                  ref={textareaRef}
                  // Arriving from a doc with a section in hand, the next thing is to type.
                  autoFocus={pending !== null}
                  value={text}
                  aria-label={`Message ${recipient}`}
                  {...(mention === null
                    ? {}
                    : {
                        "aria-controls": mentionListId,
                        "aria-activedescendant": `${mentionListId}-${activeMention}`,
                        "aria-autocomplete": "list" as const,
                      })}
                  placeholder={
                    pending === null ? `Message ${recipient}` : kinDocAskPlaceholder(pending)
                  }
                  onChange={(event) => {
                    appAtomRegistry.set(atom, event.target.value);
                    setCaret(event.target.selectionStart);
                  }}
                  onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                />
              </div>
              <div className="flex items-center justify-between px-2 pb-2">
                <div className="flex items-center">
                  {files.canAttach ? (
                    <KinAttachButton
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
