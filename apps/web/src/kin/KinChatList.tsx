import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  formatKinTime,
  kinChatRowLabel,
  kinDirectory,
  kinWaitingBannerView,
  kinWaitingRowView,
  type KinDirectory,
  type KinInboxScreenState,
} from "@t3tools/client-runtime/kin/kinScreenState";
import type { EnvironmentId, KinChatSummary, KinWaitingItem } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { BellOffIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { useSidebar } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { KinAvatar } from "./KinAvatar";
import { ApproveOnPhone } from "./KinCards";
import { kinChatListRows, type KinChatListRow } from "./kinChatListRows";
import { useNowMinuteMs } from "./useKinClock";
import { useKinInbox } from "./useKinHost";

const STATE_COPY: Record<
  Exclude<KinInboxScreenState["_tag"], "ready" | "loading" | "error">,
  { readonly title: string; readonly detail: string }
> = {
  offline: {
    title: "Kin is offline",
    detail: "Your chats come back when the connection does.",
  },
  noHost: {
    title: "Kin isn't set up here",
    detail: "Connect to a T3 server that runs Kin to see your chats.",
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

/** Every Kin chat in one list. It is the sidebar in Kin, and the page itself on a narrow window. */
export function KinChatList() {
  const params = useParams({ strict: false });
  const openChatId = "chatId" in params ? (params.chatId ?? null) : null;
  const { host, state, retry } = useKinInbox();
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
    const copy = STATE_COPY[state._tag];
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
  const stale = !(state.connected && state.inbox.live);
  const now = new Date(nowMs);
  return (
    <div className="flex flex-col gap-1">
      {stale ? (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          Offline. Showing the last update.
        </p>
      ) : null}
      <KinWaiting
        waiting={view.waiting}
        chats={inbox.chats}
        directory={directory}
        environmentId={state.environmentId}
      />
      {rows.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>No chats yet</EmptyTitle>
            <EmptyDescription>Chats with your leads show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <KinChatListItem
              key={row.chat.chatId}
              row={row}
              environmentId={state.environmentId}
              active={row.chat.chatId === openChatId}
              now={now}
              onOpen={() => {
                if (isMobile) setOpenMobile(false);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One chat: who, the last line, when, and whether it is unread, working or waiting on you. */
function KinChatListItem(props: {
  readonly row: KinChatListRow;
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
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
        aria-label={kinSentenceLabel(row, time)}
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
              {view.title}
            </span>
            {view.sentAt === null ? null : (
              <span className="shrink-0 text-xs text-sidebar-muted-foreground tabular-nums">
                {time(new Date(view.sentAt))}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5">
            {row.working ? (
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
          </span>
        </span>
      </Link>
    </li>
  );
}

function kinSentenceLabel(row: KinChatListRow, time: (date: Date) => string): string {
  const label = kinChatRowLabel({ ...row.view, author: row.author, preview: row.preview }, time);
  return [label, row.working ? "Working." : null, row.needsYou ? "Needs you." : null]
    .filter((part) => part !== null)
    .join(" ");
}

/**
 * What waits on the viewer, oldest first. Approvals are signed with the phone's device key, so
 * they point there; everything else opens its chat.
 */
function KinWaiting(props: {
  readonly waiting: ReadonlyArray<KinWaitingItem>;
  readonly chats: ReadonlyArray<KinChatSummary>;
  readonly directory: KinDirectory;
  readonly environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const banner = kinWaitingBannerView(props.waiting);
  if (banner === null) return null;
  return (
    <div className="mb-1 flex flex-col rounded-lg border border-border">
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
          <span className="font-medium">Waiting on you</span>
          <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
            {banner.summary}
          </span>
        </span>
        <Badge size="sm">{banner.count}</Badge>
      </Button>
      {open ? (
        <ul className="flex flex-col border-t border-border p-1">
          {props.waiting.map((item) => {
            const row = kinWaitingRowView(item, props.chats, props.directory.agentNames);
            return (
              <li key={item.waitingId}>
                <Link
                  to="/kin/$environmentId/$orgId/$chatId"
                  params={{
                    environmentId: props.environmentId,
                    orgId: item.orgId,
                    chatId: item.chatId,
                  }}
                  className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="text-xs font-medium text-foreground">
                    {row.label} · {row.chatTitle}
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {row.text ?? `Open the chat with ${row.chatTitle}`}
                  </span>
                  {item.reason === "approval" ? <ApproveOnPhone /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
