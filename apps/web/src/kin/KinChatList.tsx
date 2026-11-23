import { KIN_HOST_OFFLINE } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_CHAT_COPY } from "@t3tools/client-runtime/kin/kinChatFeed";
import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import {
  kinChatListAgents,
  kinChatListFold,
  kinChatListRowLabel,
  kinChatListRows,
  kinChatsKeptUp,
  KIN_CHATS_SETTLED,
  KIN_CHATS_AGENTS_TITLE,
  KIN_TEAMMATE_WELCOME,
  type KinChatListRow,
  kinRoomLine,
  KIN_CHATS_EMPTY,
} from "@t3tools/client-runtime/kin/kinChatListRows";
import {
  KIN_WAITING_TITLE,
  selectKinInboxView,
  type KinWaitsForGroup,
} from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  formatKinTime,
  kinDirectory,
  kinWaitingBannerView,
  kinWaitingRowView,
  type KinDirectory,
  type KinInboxScreenState,
} from "@t3tools/client-runtime/kin/kinScreenState";
import {
  KIN_RETIRED_LABEL,
  kinRetiredDirectAgentId,
  kinRetiredWhen,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import { useAtomValue } from "@effect/atom-react";
import { KIN_CHIEF_OF_STAFF } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import type {
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinChatSummary,
  KinLeadsListResult,
  KinOrgId,
  KinWaitingItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Link, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { BellOffIcon, ChevronDownIcon, ChevronRightIcon, BotIcon, PinIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { useSidebar } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { toastManager } from "../components/ui/toast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { cn } from "../lib/utils";
import { ApproveOnPhone } from "./ApproveOnPhone";
import { KinRestoreButton, useKinRestore } from "./KinAgentRetire";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { kinNewLeadTarget, openKinLeadForm } from "./KinNewLeadButton";
import type { KinLeadFormTarget } from "./kinLeadForm";
import { useNowMinuteMs } from "./useKinClock";
import { KinWaitingAsk } from "./KinWaitingAsk";
import { KinWaitsForFolds } from "./KinWaitsFor";
import { kinWaitingAskView } from "@t3tools/client-runtime/kin/kinWaitingAsk";
import { KinStandInLine } from "./KinStandInLine";
import { kinAccessCopy } from "./kinTeammateMark";
import { useKinInbox } from "./useKinHost";
import { useKinOpenAgentChat } from "./useKinOpenChat";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";

const STATE_COPY: Record<
  Exclude<KinInboxScreenState["_tag"], "ready" | "loading" | "error">,
  { readonly title: string; readonly detail: string }
> = {
  offline: {
    title: KIN_HOST_OFFLINE,
    detail: "Your chats come back when the connection does.",
  },
  noHost: {
    title: "Kin isn't set up here",
    detail: "Connect to a server that runs Kin to see your chats.",
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

/** Every Kin chat in one list. It is the sidebar in Kin, and the page itself on a narrow window. */
export function KinChatList() {
  const params = useParams({ strict: false });
  const openChatId = "chatId" in params ? (params.chatId ?? null) : null;
  const { host, state, retry, reread } = useKinInbox();
  const nowMs = useNowMinuteMs();
  const { isMobile, setOpenMobile } = useSidebar();
  if (state._tag === "loading") {
    return (
      <div className="flex flex-col gap-1" role="status" aria-label="Loading chats">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-2.5 px-2 py-2">
            <Skeleton className="size-9" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (state._tag === "error") {
    return (
      <div className="flex flex-col items-start gap-3 p-2">
        <Alert variant="error">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }
  if (state._tag !== "ready") {
    const copy = kinAccessCopy(state._tag, STATE_COPY[state._tag]);
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>{copy.title}</EmptyTitle>
          <EmptyDescription>{copy.detail}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const directory = kinDirectory(host);
  const inbox = state.inbox.value;
  const view = selectKinInboxView(inbox);
  const rows = kinChatListRows(view, directory);
  const liveRows = rows.filter((row) => !row.retired);
  const retiredRows = rows.filter((row) => row.retired);
  const stale = state.offline;
  const now = new Date(nowMs);
  const mine = kinNewLeadTarget(host);
  const closeSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <div className="flex flex-col gap-1">
      {stale ? (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          Offline. Showing the last update.
        </p>
      ) : (
        <KinStandInLine className="px-2 py-1 text-xs text-muted-foreground" />
      )}
      <KinWaiting
        waiting={view.waiting}
        waitsFor={view.waitsFor}
        chats={inbox.chats}
        directory={directory}
        environmentId={state.environmentId}
        onReread={reread}
      />
      {rows.length === 0 ? (
        mine === null ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>{KIN_CHATS_EMPTY.title}</EmptyTitle>
              <EmptyDescription>{KIN_CHATS_EMPTY.none}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <KinFirstAgent target={mine} />
        )
      ) : (
        <KinFoldedChats
          rows={liveRows}
          me={directory.me}
          environmentId={state.environmentId}
          target={mine}
          openChatId={openChatId}
          now={now}
          onOpen={closeSidebar}
        />
      )}
      {mine === null ? null : (
        <KinAgentsToMessage
          environmentId={mine.environmentId}
          orgId={mine.orgId}
          chats={inbox.chats}
          me={directory.me}
          onOpen={closeSidebar}
        />
      )}
      {retiredRows.length === 0 ? null : (
        <KinRetiredChats
          rows={retiredRows}
          retiredAgents={directory.retiredAgents}
          environmentId={state.environmentId}
          orgId={mine?.orgId ?? null}
          openChatId={openChatId}
          now={now}
          onOpen={closeSidebar}
        />
      )}
    </div>
  );
}

const SETTLED_OPEN_KEY = "kin:chats:settled-open";
const NOBODY_KEPT: ReadonlySet<KinChatId> = new Set();
type LeadsResult = AsyncResult.AsyncResult<KinLeadsListResult, unknown>;
const noLeadsAtom: Atom.Atom<LeadsResult> = Atom.make<LeadsResult>(AsyncResult.initial());

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const pageVisible = () => document.visibilityState === "visible";

/**
 * The chats on top, then "Settled (N)" over the rest, opened or closed as this browser last left
 * it. Who is up is worked out when the page comes back into view; while it is in view a row only
 * ever joins the top, so nothing moves from under the pointer.
 */
function KinFoldedChats(props: {
  readonly rows: ReadonlyArray<KinChatListRow>;
  readonly me: ReadonlySet<string>;
  readonly environmentId: EnvironmentId;
  readonly target: KinLeadFormTarget | null;
  readonly openChatId: string | null;
  readonly now: Date;
  readonly onOpen: () => void;
}) {
  const { target } = props;
  const leads = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        target === null
          ? noLeadsAtom
          : kinClient.leads({
              environmentId: target.environmentId,
              input: { orgId: target.orgId },
            }),
      ),
    ),
  );
  const inView = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const [kept, setKept] = useState({ inView: false, ids: NOBODY_KEPT });
  const entering = inView && !kept.inView;
  const fold = kinChatListFold(props.rows, {
    mainAgentId: leads?.teamAgentId ?? null,
    keptUp: entering ? NOBODY_KEPT : kept.ids,
  });
  const keptNext = kinChatsKeptUp(entering ? NOBODY_KEPT : kept.ids, fold.up);
  if (inView !== kept.inView || keptNext !== kept.ids) setKept({ inView, ids: keptNext });
  const [open, setOpen] = useLocalStorage(SETTLED_OPEN_KEY, false, Schema.Boolean);
  const [toggled, setToggled] = useState<boolean | null>(null);
  // The open chat's row is in sight until the fold is closed by hand.
  const showSettled =
    toggled ?? (open || fold.settled.some((row) => row.chat.chatId === props.openChatId));
  const item = (row: KinChatListRow) => (
    <KinChatListItem
      key={row.chat.chatId}
      row={row}
      me={props.me}
      environmentId={props.environmentId}
      active={row.chat.chatId === props.openChatId}
      pinned={!fold.fixed.has(row.chat.chatId) && row.pinnedAt !== null}
      now={props.now}
      onOpen={props.onOpen}
    />
  );
  return (
    <>
      <ul className="flex flex-col gap-0.5">{fold.up.map(item)}</ul>
      {fold.settled.length === 0 ? null : (
        <div className="mt-1 flex flex-col">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showSettled}
            className="justify-start"
            onClick={() => {
              setToggled(!showSettled);
              setOpen(!showSettled);
            }}
          >
            {showSettled ? <ChevronDownIcon /> : <ChevronRightIcon />}
            <span className="min-w-0 flex-1 text-start font-normal text-sidebar-muted-foreground">
              {KIN_CHATS_SETTLED}
            </span>
            <span className="text-xs font-normal text-sidebar-muted-foreground tabular-nums">
              {fold.settled.length}
            </span>
          </Button>
          {showSettled ? <ul className="flex flex-col gap-0.5">{fold.settled.map(item)}</ul> : null}
        </div>
      )}
    </>
  );
}

/** Agents the host lets this person message that they have no chat with yet; never counted unread. */
function KinAgentsToMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chats: ReadonlyArray<KinChatSummary>;
  readonly me: ReadonlySet<string>;
  readonly onOpen: () => void;
}) {
  const leads = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        kinClient.leads({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
      ),
    ),
  );
  const openAgentChat = useKinOpenAgentChat();
  const agents = kinChatListAgents(props.chats, leads, props.me);
  if (agents.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col">
      <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">{KIN_CHATS_AGENTS_TITLE}</p>
      <ul className="flex flex-col gap-0.5">
        {agents.map((agent) => (
          <li key={agent.agentId}>
            <button
              type="button"
              aria-label={`Message ${agent.name}`}
              onClick={() => {
                props.onOpen();
                void openAgentChat(props.environmentId, props.orgId, agent.agentId).then(
                  (problem) => {
                    if (problem !== null) toastManager.add({ type: "error", title: problem });
                  },
                );
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-start outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset"
            >
              <KinAvatar avatar={kinAgentAvatar(agent.agentId)} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-sidebar-foreground">
                  {agent.name}
                </span>
                {agent.intro === null ? null : (
                  <span className="truncate text-xs text-sidebar-muted-foreground">
                    {agent.intro}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type AgentsResult = AsyncResult.AsyncResult<KinLeadsListResult, unknown>;
// Stands in where this browser may not ask for retired agents, so it asks the host nothing.
const noAgentsAtom: Atom.Atom<AgentsResult> = Atom.make<AgentsResult>(AsyncResult.initial());

/**
 * Chats with agents that were retired, after everything else. The owner gets them as a quiet
 * group that starts closed, each with the day it was retired and Restore; anyone else just keeps
 * their own chat with it in the list.
 */
function KinRetiredChats(props: {
  readonly rows: ReadonlyArray<KinChatListRow>;
  readonly retiredAgents: ReadonlySet<string>;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId | null;
  readonly openChatId: string | null;
  readonly now: Date;
  readonly onOpen: () => void;
}) {
  const { environmentId, orgId } = props;
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const agentsAtom: Atom.Atom<AgentsResult> =
    canRestore && orgId !== null ? kinClient.agents({ environmentId, orgId }) : noAgentsAtom;
  const agents = useAtomValue(agentsAtom);
  const holdsOpenChat = props.rows.some((row) => row.chat.chatId === props.openChatId);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? holdsOpenChat;
  if (!canRestore) {
    return (
      <ul className="flex flex-col gap-0.5">
        {props.rows.map((row) => (
          <KinChatListItem
            key={row.chat.chatId}
            row={row}
            environmentId={environmentId}
            active={row.chat.chatId === props.openChatId}
            now={props.now}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
    );
  }
  const mine = Option.getOrNull(AsyncResult.value(agents))?.leads ?? [];
  return (
    <div className="mt-1 flex flex-col">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className="justify-start"
        onClick={() => setToggled(!open)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <span className="min-w-0 flex-1 text-start font-normal text-sidebar-muted-foreground">
          {KIN_RETIRED_LABEL}
        </span>
        <span className="text-xs font-normal text-sidebar-muted-foreground tabular-nums">
          {props.rows.length}
        </span>
      </Button>
      {open ? (
        <ul className="flex flex-col gap-0.5">
          {props.rows.map((row) => {
            const agentId = kinRetiredDirectAgentId(row.chat, props.retiredAgents);
            const profile = mine.find((held) => held.agentId === agentId);
            return (
              <KinRetiredChatItem
                key={row.chat.chatId}
                row={row}
                environmentId={environmentId}
                // Only the owner's own agent is theirs to restore.
                agentId={profile?.agentId ?? null}
                when={kinRetiredWhen(profile?.retired?.at, props.now.getTime())}
                active={row.chat.chatId === props.openChatId}
                onOpen={props.onOpen}
              />
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function KinRetiredChatItem(props: {
  readonly row: KinChatListRow;
  readonly environmentId: EnvironmentId;
  readonly agentId: KinAgentId | null;
  readonly when: string;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  const { chat, view } = props.row;
  const target = {
    environmentId: props.environmentId,
    orgId: chat.orgId,
    // Never sent without an agent: the button below is hidden then.
    agentId: props.agentId ?? ("" as KinAgentId),
    name: view.title ?? "",
  };
  const restore = useKinRestore(target);
  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-1">
        <Link
          to="/kin/$environmentId/$orgId/$chatId"
          params={{ environmentId: props.environmentId, orgId: chat.orgId, chatId: chat.chatId }}
          aria-label={`${view.title}. ${props.when}.`}
          aria-current={props.active ? "page" : undefined}
          data-active={props.active}
          onClick={props.onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected"
        >
          <KinAvatar avatar={view.avatar} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-sidebar-muted-foreground">
              {view.title}
            </span>
            <span className="truncate text-xs text-sidebar-muted-foreground">{props.when}</span>
          </span>
        </Link>
        {props.agentId === null ? null : (
          <KinRestoreButton agent={target} busy={restore.busy} onRestore={restore.run} quiet />
        )}
      </div>
      {restore.problem === null ? null : (
        <p role="alert" className="px-2 pb-1 text-xs text-destructive-foreground">
          {restore.problem}
        </p>
      )}
    </li>
  );
}

/** One chat: who, the last line, when, and whether it is unread, working or waiting on you. */
function KinChatListItem(props: {
  readonly row: KinChatListRow;
  /** Who "You" is in the company chat's line of who is there. */
  readonly me?: ReadonlySet<string>;
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
  /** Pinned to the top by this person; the rows always on top show no pin. */
  readonly pinned?: boolean;
  readonly now: Date;
  readonly onOpen: () => void;
}) {
  const { row } = props;
  const { view, chat } = row;
  const unread = view.unread > 0;
  const time = (date: Date) => formatKinTime(date, props.now);
  return (
    <li>
      <Link
        to="/kin/$environmentId/$orgId/$chatId"
        params={{ environmentId: props.environmentId, orgId: chat.orgId, chatId: chat.chatId }}
        aria-label={kinChatListRowLabel(row, time)}
        aria-current={props.active ? "page" : undefined}
        data-active={props.active}
        onClick={props.onOpen}
        className="flex items-center gap-2.5 rounded-md px-2 py-2 outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected"
      >
        <KinAvatar avatar={view.avatar} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm text-sidebar-foreground",
                unread ? "font-semibold" : "font-medium",
              )}
            >
              {view.title ?? <Skeleton className="h-3.5 w-1/2" aria-hidden />}
            </span>
            {props.pinned === true ? (
              <PinIcon aria-hidden className="size-3 shrink-0 text-sidebar-muted-foreground" />
            ) : null}
            {view.sentAt === null ? null : (
              <span className="shrink-0 text-xs text-sidebar-muted-foreground tabular-nums">
                {time(new Date(view.sentAt))}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5">
            {row.retired ? (
              <span className="min-w-0 flex-1 truncate text-xs text-sidebar-muted-foreground">
                {KIN_RETIRED_LABEL}
              </span>
            ) : row.working ? (
              <span className="min-w-0 flex-1 truncate text-xs text-info-foreground">Working…</span>
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  unread ? "text-sidebar-foreground" : "text-sidebar-muted-foreground",
                )}
              >
                {row.author === null ? null : `${row.author}: `}
                {row.preview}
              </span>
            )}
            {view.muted ? (
              <BellOffIcon aria-hidden className="size-3 shrink-0 text-sidebar-muted-foreground" />
            ) : null}
            {row.needsYou ? (
              <Badge size="sm" variant="warning">
                Needs you
              </Badge>
            ) : null}
            {unread ? <Badge size="sm">{view.unread}</Badge> : null}
            {row.quietNew ? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-sidebar-muted-foreground"
              />
            ) : null}
          </span>
          {row.company && props.me !== undefined ? (
            <KinRoomLine environmentId={props.environmentId} chat={chat} me={props.me} />
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/** Who is in the company chat, kept current by the members read its stream refreshes. */
function KinRoomLine(props: {
  readonly environmentId: EnvironmentId;
  readonly chat: KinChatSummary;
  readonly me: ReadonlySet<string>;
}) {
  const result = useAtomValue(
    kinClient.chatMembers({
      environmentId: props.environmentId,
      input: { chatId: props.chat.chatId },
    }),
  );
  const members = Option.getOrNull(AsyncResult.value(result))?.members;
  if (members === undefined) return null;
  return (
    <span className="truncate text-xs text-sidebar-muted-foreground">
      {kinRoomLine(members, props.me)}
    </span>
  );
}

/**
 * What waits on the viewer, oldest first. Approvals are signed with the phone's device key, so
 * they point there; everything else opens its chat. Then, folded, what waits on someone else
 * that the viewer may see, to look at only.
 */
function KinWaiting(props: {
  readonly waiting: ReadonlyArray<KinWaitingItem>;
  readonly waitsFor: ReadonlyArray<KinWaitsForGroup>;
  readonly chats: ReadonlyArray<KinChatSummary>;
  readonly directory: KinDirectory;
  readonly environmentId: EnvironmentId;
  readonly onReread: () => void;
}) {
  const [open, setOpen] = useState(false);
  const nowMs = useNowMinuteMs();
  const banner = kinWaitingBannerView(props.waiting, props.waitsFor);
  if (banner === null) return null;
  return (
    <div className="mb-1 flex flex-col">
      <Button
        variant="ghost"
        size="sm-multiline"
        aria-expanded={open}
        aria-label={banner.accessibilityLabel}
        className="justify-start"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <span className="flex min-w-0 flex-1 flex-col items-start text-start">
          <span className="font-medium">{KIN_WAITING_TITLE}</span>
          <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
            {banner.summary}
          </span>
        </span>
        {banner.count === 0 ? null : <Badge size="sm">{banner.count}</Badge>}
      </Button>
      {open ? (
        <ul className="flex flex-col p-1">
          {props.waiting.map((item) => {
            const row = kinWaitingRowView(item, props.chats, props.directory.agentNames);
            const ask = kinWaitingAskView(item, nowMs);
            return (
              <li key={item.waitingId}>
                <Link
                  to="/kin/$environmentId/$orgId/$chatId"
                  params={{
                    environmentId: props.environmentId,
                    orgId: item.orgId,
                    chatId: item.chatId,
                  }}
                  search={item.messageId === null ? {} : { message: item.messageId }}
                  className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="text-xs font-medium text-foreground">
                    {row.label} · {row.chatTitle}
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {row.text ?? KIN_CHAT_COPY.openChatWith(row.chatTitle)}
                  </span>
                  {row.excerpt === null ? null : (
                    <span className="line-clamp-3 whitespace-pre-line text-xs text-foreground">
                      {row.excerpt}
                    </span>
                  )}
                  {item.reason === "approval" ? <ApproveOnPhone /> : null}
                </Link>
                {ask === null ? null : (
                  <KinWaitingAsk
                    ask={ask}
                    item={item}
                    environmentId={props.environmentId}
                    onReread={props.onReread}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {open ? (
        <KinWaitsForFolds groups={props.waitsFor} chats={props.chats} directory={props.directory} />
      ) : null}
    </div>
  );
}

/** An empty company starts with its first agent; the Chief of staff is offered filled in. */
function KinFirstAgent(props: { readonly target: KinLeadFormTarget }) {
  const canAddLead = useAtomValue(kinClient.leadCreate.permissionAtom(props.target.environmentId));
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>
          {canAddLead ? KIN_CHATS_EMPTY.firstAgent : KIN_TEAMMATE_WELCOME.title}
        </EmptyTitle>
        <EmptyDescription>
          {canAddLead ? KIN_CHATS_EMPTY.chiefPitch : KIN_TEAMMATE_WELCOME.detail}
        </EmptyDescription>
      </EmptyHeader>
      {canAddLead ? (
        <Button
          size="sm"
          onClick={() => openKinLeadForm({ ...props.target, suggested: KIN_CHIEF_OF_STAFF })}
        >
          <BotIcon />
          {KIN_MONEY.createChief}
        </Button>
      ) : null}
    </Empty>
  );
}
