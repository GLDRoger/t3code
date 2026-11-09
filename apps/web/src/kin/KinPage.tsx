import { LegendList } from "@legendapp/list/react";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  formatKinTime,
  kinChatRowLabel,
  kinDirectory,
  kinInboxListRows,
  kinWaitingBannerView,
  kinWaitingRowView,
  type KinChatRowView,
  type KinDirectory,
  type KinInboxListRow,
  type KinInboxScreenState,
} from "@t3tools/client-runtime/kin/kinScreenState";
import type { EnvironmentId, KinChatSummary, KinWaitingItem } from "@t3tools/contracts";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { ApproveOnPhone } from "./KinCards";
import { startKinOutbox } from "./kinOutbox";
import { useKinInbox } from "./useKinHost";

/**
 * Kin's chats: the list beside the open chat on wide windows, one or the other on narrow ones.
 * The open chat is the child route.
 */
export function KinPage() {
  startKinOutbox();
  const params = useParams({ strict: false });
  const openChatId = "chatId" in params ? (params.chatId ?? null) : null;
  const { host, state, retry } = useKinInbox();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <WorkspaceBreadcrumb ariaLabel="Kin">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Kin</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 border-t border-border">
        <nav
          aria-label="Kin chats"
          className={cn(
            "min-h-0 w-full flex-col md:flex md:w-80 md:shrink-0 md:border-e md:border-border",
            openChatId === null ? "flex" : "hidden",
          )}
        >
          <KinChatList
            state={state}
            directory={kinDirectory(host)}
            openChatId={openChatId}
            onRetry={retry}
          />
        </nav>
        <section
          aria-label="Chat"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col md:flex",
            openChatId === null ? "hidden" : "flex",
          )}
        >
          <Outlet />
        </section>
      </div>
    </SidebarInset>
  );
}

/** The chat pane before a chat is picked, on wide windows. */
export function KinNoChat() {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>Pick a chat</EmptyTitle>
        <EmptyDescription>Your leads' chats are on the left.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const STATE_COPY: Record<
  Exclude<KinInboxScreenState["_tag"], "ready" | "loading" | "error">,
  { readonly title: string; readonly detail: string }
> = {
  offline: {
    title: "Kin is offline",
    detail: "Your chats show up when the Kin environment reconnects.",
  },
  noHost: {
    title: "Kin isn't set up here",
    detail: "Connect to a T3 server that runs Kin to see your leads' chats.",
  },
  unauthorized: {
    title: "This browser can't read Kin chats",
    detail: "Pair it again from the Mac.",
  },
  noIdentity: {
    title: "Kin doesn't know who you are on this server yet",
    detail: "Ask whoever runs Kin here to add you, then come back.",
  },
};

function KinChatList(props: {
  readonly state: KinInboxScreenState;
  readonly directory: KinDirectory;
  readonly openChatId: string | null;
  readonly onRetry: () => void;
}) {
  const { state } = props;
  if (state._tag === "loading") {
    return (
      <div className="flex flex-col gap-1 p-2" role="status" aria-label="Loading chats">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3 px-2 py-2.5">
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
      <div className="flex flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
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
  const inbox = state.inbox.value;
  const view = selectKinInboxView(inbox);
  const rows = kinInboxListRows(view, props.directory);
  const notice = state.connected && state.inbox.live ? null : "Offline. Showing the last update.";
  const chatsById = new Map(inbox.chats.map((chat) => [chat.chatId, chat]));
  const header = (
    <div className="flex flex-col gap-2 px-2 pb-1 pt-2">
      {notice === null ? null : (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <KinWaiting
        waiting={view.waiting}
        chats={inbox.chats}
        directory={props.directory}
        environmentId={state.environmentId}
      />
    </div>
  );
  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>No chats yet</EmptyTitle>
            <EmptyDescription>Your lead's chat appears here once Kin is set up.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <LegendList<KinInboxListRow>
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.type}
      estimatedItemSize={60}
      recycleItems={false}
      extraData={props.openChatId}
      className="scrollbar-gutter-both min-h-0 flex-1"
      ListHeaderComponent={header}
      ListFooterComponent={<div className="h-2" />}
      renderItem={({ item }) =>
        item.type === "fold" ? (
          <h2
            aria-label={item.accessibilityLabel}
            className="px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground"
          >
            {item.title} · {item.count}
          </h2>
        ) : (
          <KinChatRow
            view={item.view}
            chat={chatsById.get(item.view.chatId)}
            environmentId={state.environmentId}
            active={item.view.chatId === props.openChatId}
          />
        )
      }
    />
  );
}

/** One chat. Unread shows as a count and a bolder title, never as a highlight. */
function KinChatRow(props: {
  readonly view: KinChatRowView;
  readonly chat: KinChatSummary | undefined;
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
}) {
  const { view, chat } = props;
  if (chat === undefined) return null;
  const unread = view.unread > 0;
  return (
    <div className="px-2">
      <Link
        to="/kin/$environmentId/$orgId/$chatId"
        params={{ environmentId: props.environmentId, orgId: chat.orgId, chatId: view.chatId }}
        aria-label={kinChatRowLabel(view, (date) => formatKinTime(date))}
        aria-current={props.active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg px-2 py-2.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.active && "bg-accent",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium",
            view.avatar.kind === "agent"
              ? "bg-primary/12 text-primary"
              : "bg-secondary text-secondary-foreground",
          )}
        >
          {view.avatar.initials}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm text-foreground",
                unread && "font-semibold",
              )}
            >
              {view.title}
            </span>
            {view.sentAt === null ? null : (
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatKinTime(new Date(view.sentAt))}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {view.author === null ? null : `${view.author}: `}
              {view.preview}
            </span>
            {unread ? <Badge size="sm">{view.unread}</Badge> : null}
          </span>
        </span>
      </Link>
    </div>
  );
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
    <div className="flex flex-col rounded-lg border border-border">
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
