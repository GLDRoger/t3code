import { useAtomValue } from "@effect/atom-react";
import {
  KIN_MEMORY_EMPTY,
  KIN_MEMORY_FORGET,
  KIN_MEMORY_LOAD_FAILED,
  KIN_MEMORY_NO_EDITS,
  KIN_MEMORY_SEARCH_PLACEHOLDER,
  KIN_MEMORY_TITLE,
  createKinMemoryActions,
  kinMemoryEntrySummary,
  kinMemoryView,
  type KinMemoryActions,
  type KinMemoryConfirmAll,
  type KinMemoryItemView,
  type KinMemoryOriginView,
  type KinMemoryRow,
} from "@t3tools/client-runtime/kin/kinMemoryScreen";
import type { EnvironmentId, KinMemoryListResult, KinOrgId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, BrainIcon, GlobeIcon, MessageSquareIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { isElectron } from "../env";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

interface KinMemoryTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

/** The way in from the chat list, for the owner only. Its second line says how much waits. */
export function KinMemoryEntry(
  props: KinMemoryTarget & { readonly active: boolean; readonly onOpen: () => void },
) {
  const allowed = useAtomValue(kinClient.memorySetVisibility.permissionAtom(props.environmentId));
  return allowed ? <PermittedMemoryEntry {...props} /> : null;
}

function PermittedMemoryEntry(
  props: KinMemoryTarget & { readonly active: boolean; readonly onOpen: () => void },
) {
  const { environmentId, orgId } = props;
  const result = useAtomValue(kinClient.memory({ environmentId, input: { orgId } }));
  const list = Option.getOrNull(AsyncResult.value(result));
  // The host refused: this browser may change settings but isn't the owner's.
  if (list === null && AsyncResult.isFailure(result)) return null;
  return (
    <Link
      to="/kin/$environmentId/$orgId/memory"
      params={{ environmentId, orgId }}
      aria-current={props.active ? "page" : undefined}
      data-active={props.active}
      onClick={props.onOpen}
      className="flex items-center gap-2.5 rounded-md px-2 py-2 outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected"
    >
      <span className="flex size-10 shrink-0 items-center justify-center text-sidebar-muted-foreground">
        <BrainIcon aria-hidden className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-sidebar-foreground">
          {KIN_MEMORY_TITLE}
        </span>
        <span className="truncate text-xs text-sidebar-muted-foreground">
          {kinMemoryEntrySummary(list)}
        </span>
      </span>
    </Link>
  );
}

/** What the owner's leads remember, and who may know each thing. */
export function KinMemoryView(props: KinMemoryTarget) {
  const allowed = useAtomValue(kinClient.memorySetVisibility.permissionAtom(props.environmentId));
  return (
    <>
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
        <WorkspaceBreadcrumb ariaLabel={KIN_MEMORY_TITLE}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{KIN_MEMORY_TITLE}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {allowed ? (
        <KinMemoryBody {...props} />
      ) : (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>Only the owner can open this</EmptyTitle>
            <EmptyDescription>
              What the agents remember is shown to the person who runs this workspace.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

function KinMemoryBody({ environmentId, orgId }: KinMemoryTarget) {
  const listAtom = kinClient.memory({ environmentId, input: { orgId } });
  const result = useAtomValue(listAtom);
  const setVisibility = useAtomCommand(kinClient.memorySetVisibility, { reportFailure: false });
  const confirm = useAtomCommand(kinClient.memoryConfirm, { reportFailure: false });
  const forget = useAtomCommand(kinClient.memoryForget, { reportFailure: false });
  const [forgetting, setForgetting] = useState<KinMemoryItemView | null>(null);
  const [edits, setEdits] = useState(KIN_MEMORY_NO_EDITS);
  const [search, setSearch] = useState("");
  // Whose words and which agent an item names; until these arrive a row says "a teammate" or "an agent".
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  const agents = useAtomValue(
    kinClient.leads({ environmentId, input: { orgId, includeRetired: true } }),
  );
  // Quotes read in full, kept here because the list recycles its rows.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [actions] = useState(() =>
    createKinMemoryActions({
      orgId,
      setVisibility: (input) => setVisibility({ environmentId, input }),
      confirmSuggestions: (input) => confirm({ environmentId, input }),
      forget: (input) => forget({ environmentId, input }),
      update: setEdits,
      refresh: () => appAtomRegistry.refresh(listAtom),
    }),
  );
  // What was last read stays up while it is read again.
  const list = Option.getOrNull(AsyncResult.value(result));
  if (list === null) {
    return AsyncResult.isFailure(result) ? (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{KIN_MEMORY_LOAD_FAILED}</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={() => appAtomRegistry.refresh(listAtom)}>
          Retry
        </Button>
      </div>
    ) : (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4"
        role="status"
        aria-label="Loading what your agents remember"
      >
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    );
  }
  const view = kinMemoryView(list, edits, search, {
    people: Option.getOrNull(AsyncResult.value(people))?.people ?? [],
    agents: Option.getOrNull(AsyncResult.value(agents))?.leads ?? [],
  });
  if (view.total === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>{KIN_MEMORY_EMPTY.title}</EmptyTitle>
          <EmptyDescription>{KIN_MEMORY_EMPTY.detail}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      {/* The leads of a busy company remember hundreds of things; only the rows in view mount. */}
      <LegendList<KinMemoryRow>
        data={view.rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        extraData={[view.confirmAll, opened]}
        recycleItems
        ListHeaderComponent={
          view.searchable || edits.problem !== null ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-2">
              {view.searchable ? (
                <Input
                  type="search"
                  aria-label={KIN_MEMORY_SEARCH_PLACEHOLDER}
                  placeholder={KIN_MEMORY_SEARCH_PLACEHOLDER}
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                />
              ) : null}
              {edits.problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{edits.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          ) : null
        }
        ListEmptyComponent={
          <p
            role="status"
            className="mx-auto w-full max-w-3xl px-4 py-6 text-sm text-muted-foreground"
          >
            {view.noMatch}
          </p>
        }
        renderItem={({ item: row }) => (
          <div className="mx-auto w-full max-w-3xl px-4">
            {row.type === "section" ? (
              <KinMemorySection
                row={row}
                confirmAll={row.state === "suggested" ? view.confirmAll : null}
                onConfirmAll={(all) => void actions.confirmAll(list, all)}
              />
            ) : (
              <KinMemoryItem
                row={row}
                list={list}
                actions={actions}
                onForget={setForgetting}
                quoteOpen={opened.has(row.item.itemId)}
                onToggleQuote={() =>
                  setOpened((current) => {
                    const next = new Set(current);
                    if (!next.delete(row.item.itemId)) next.add(row.item.itemId);
                    return next;
                  })
                }
              />
            )}
          </div>
        )}
        estimatedItemSize={64}
        drawDistance={640}
        className="min-h-0 flex-1 overscroll-contain pb-6"
      />
      <AlertDialog
        open={forgetting !== null}
        onOpenChange={(open) => {
          if (!open) setForgetting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_MEMORY_FORGET.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {forgetting === null ? null : KIN_MEMORY_FORGET.body(forgetting.title)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (forgetting !== null) void actions.forget(list, forgetting.itemId);
                setForgetting(null);
              }}
            >
              {KIN_MEMORY_FORGET.action}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function KinMemorySection(props: {
  readonly row: Extract<KinMemoryRow, { readonly type: "section" }>;
  readonly confirmAll: KinMemoryConfirmAll | null;
  readonly onConfirmAll: (all: KinMemoryConfirmAll) => void;
}) {
  const { row, confirmAll } = props;
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b pt-6 pb-2">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">
          {row.title} <span className="font-normal text-muted-foreground">{row.count}</span>
        </h2>
        <p className="text-xs text-muted-foreground">{row.hint}</p>
      </div>
      {confirmAll === null ? null : (
        <Button size="sm" onClick={() => props.onConfirmAll(confirmAll)}>
          {confirmAll.label}
        </Button>
      )}
    </div>
  );
}

function KinMemoryItem(props: {
  readonly row: Extract<KinMemoryRow, { readonly type: "item" }>;
  readonly list: KinMemoryListResult;
  readonly actions: KinMemoryActions;
  readonly onForget: (item: KinMemoryItemView) => void;
  readonly quoteOpen: boolean;
  readonly onToggleQuote: () => void;
}) {
  const { item } = props.row;
  return (
    <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-foreground">{item.title}</span>
        {item.preview === null ? null : (
          <span className="line-clamp-2 text-xs text-muted-foreground">{item.preview}</span>
        )}
        {item.from === null ? null : (
          <span className="text-xs text-muted-foreground">{item.from}</span>
        )}
        {item.origin === null ? null : (
          <KinMemoryOrigin
            origin={item.origin}
            open={props.quoteOpen}
            onToggle={props.onToggleQuote}
          />
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        {item.actions.map((action) => (
          <Button
            key={action.to}
            size="xs"
            variant={action.to === "team" ? "outline" : "ghost"}
            disabled={item.busy}
            aria-label={action.accessibilityLabel}
            onClick={() => void props.actions.change(props.list, item.itemId, action.to)}
          >
            {action.label}
          </Button>
        ))}
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={item.busy}
          aria-label={item.forget.accessibilityLabel}
          onClick={() => props.onForget(item)}
        >
          {item.forget.label}
        </Button>
      </div>
    </div>
  );
}

const ORIGIN_ICON = { said: MessageSquareIcon, worked_out: SparklesIcon, outside: GlobeIcon };

/** One quiet line: who said it or which agent worked it out, when, and the words if any. */
function KinMemoryOrigin(props: {
  readonly origin: KinMemoryOriginView;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const { origin, open } = props;
  const Icon = ORIGIN_ICON[origin.kind];
  if (origin.quote === null) {
    return (
      <span className="flex items-start gap-1.5 pt-0.5 text-xs text-muted-foreground">
        <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
        {origin.line}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={props.onToggle}
      className="flex items-start gap-1.5 rounded-sm pt-0.5 text-start text-xs text-muted-foreground outline-none ring-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
    >
      <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className={open ? undefined : "line-clamp-2"}>
        {origin.line} <span className="text-foreground/80">“{origin.quote}”</span>
      </span>
    </button>
  );
}
