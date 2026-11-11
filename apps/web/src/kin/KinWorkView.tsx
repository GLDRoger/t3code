import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_OFFLINE,
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_SEARCH_PLACEHOLDER,
  KIN_WORK_STALE,
  KIN_WORK_TITLE,
  kinWorkEntrySummary,
  kinWorkHostEdits,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOverview,
  kinWorkRow,
  kinWorkShown,
  type KinWorkFilter,
  type KinWorkOverview,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  type KinWorkAction,
  type KinWorkNotice,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_WORK_LIST_INITIAL,
  createKinWorkList,
  type KinWorkListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecord, KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, ListChecksIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinAvatar } from "./KinAvatar";
import { KinWorkItemSheet } from "./KinWorkItemSheet";
import { KinWorkNewDialog } from "./KinWorkNewDialog";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import {
  kinWorkLiveAtom,
  useKinWork,
  useKinWorkChanges,
  useKinWorkDirectory,
  type KinWorkChangesHandle,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

/** The way in from the chat list, for the owner only. Its second line says what needs a look. */
export function KinWorkEntry(
  props: KinWorkTarget & { readonly active: boolean; readonly onOpen: () => void },
) {
  const { environmentId, orgId } = props;
  const state = useKinWork(props);
  // A teammate, or a host that couldn't be read: no way in rather than a dead one.
  if (state._tag === "refused" || state._tag === "failed") return null;
  return (
    <Link
      to="/kin/$environmentId/$orgId/work"
      params={{ environmentId, orgId }}
      aria-current={props.active ? "page" : undefined}
      data-active={props.active}
      onClick={props.onOpen}
      className="flex items-center gap-2.5 rounded-md px-2 py-2 outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected"
    >
      <span className="flex size-10 shrink-0 items-center justify-center text-sidebar-muted-foreground">
        <ListChecksIcon aria-hidden className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-sidebar-foreground">
          {KIN_WORK_TITLE}
        </span>
        <span className="truncate text-xs text-sidebar-muted-foreground">
          {kinWorkEntrySummary(state._tag === "ready" ? state.live.summary : null)}
        </span>
      </span>
    </Link>
  );
}

/** Everything someone owes someone: what is open, who has it, and the way to hand it on. */
export function KinWorkView({
  openKey,
  onOpenKey: setOpenKey,
  ...props
}: KinWorkTarget & {
  readonly openKey: KinRecordKey | null;
  readonly onOpenKey: (key: KinRecordKey | null) => void;
}) {
  const state = useKinWork(props);
  const canAdd = useAtomValue(kinClient.workCreate.permissionAtom(props.environmentId));
  const directory = useKinWorkDirectory(props, state._tag === "ready");
  const changes = useKinWorkChanges(props);
  const [adding, setAdding] = useState(false);
  const add = state._tag === "ready" && canAdd ? () => setAdding(true) : null;
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
        <WorkspaceBreadcrumb ariaLabel={KIN_WORK_TITLE}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{KIN_WORK_TITLE}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {add === null ? null : (
          <div className="ms-auto">
            <Button size="sm" onClick={add}>
              <PlusIcon />
              {KIN_WORK_NEW}
            </Button>
          </div>
        )}
      </WorkspacePageHeader>
      {state._tag === "refused" ? (
        <Notice {...KIN_WORK_ONLY_OWNER} />
      ) : state._tag === "offline" ? (
        <Notice {...KIN_WORK_OFFLINE} />
      ) : state._tag === "failed" ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 p-4">
          <Alert variant="error">
            <AlertDescription>{KIN_WORK_LOAD_FAILED}. Check your connection.</AlertDescription>
          </Alert>
          <Button
            size="sm"
            variant="outline"
            onClick={() => appAtomRegistry.refresh(kinWorkLiveAtom(props))}
          >
            Retry
          </Button>
        </div>
      ) : state._tag === "loading" ? (
        <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading Work">
          <RowSkeletons />
        </div>
      ) : (
        <KinWorkBody
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          changes={changes}
          onOpen={setOpenKey}
          onAdd={add}
        />
      )}
      {openKey === null || state._tag !== "ready" ? null : (
        <KinWorkItemSheet
          // A fresh sheet per task, so one task's hand-over never shows on another.
          key={openKey}
          {...props}
          itemKey={openKey}
          directory={directory}
          changes={changes}
          onOpenKey={setOpenKey}
          onClose={() => setOpenKey(null)}
        />
      )}
      {adding ? (
        <KinWorkNewDialog
          {...props}
          directory={directory}
          onAdded={(key) => {
            setAdding(false);
            setOpenKey(key);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  );
}

function Notice(props: { readonly title: string; readonly detail: string }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function RowSkeletons() {
  return (
    <div className="flex flex-col gap-4 py-2">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-start gap-3 px-2">
          <Skeleton className="size-4" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function KinWorkBody(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly changes: KinWorkChangesHandle;
    readonly onOpen: (key: KinRecordKey) => void;
    readonly onAdd: (() => void) | null;
  },
) {
  const { environmentId, orgId, live } = props;
  const { names } = props.directory;
  const { state: changed, changes } = props.changes;
  const hostEdits = kinWorkHostEdits(live.summary);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)) && hostEdits;
  const now = new Date(useNowMinuteMs());
  const [listState, setListState] = useState<KinWorkListState>(KIN_WORK_LIST_INITIAL);
  const [list] = useState(() =>
    createKinWorkList({
      orgId,
      read: (input) => kinClient.workList.run(appAtomRegistry, { environmentId, input }),
      onChange: setListState,
      now: Date.now,
      // The first counts are in before the list exists, and say which filters the host has.
      hostFilters: () =>
        kinWorkHostEdits(
          appAtomRegistry
            .get(kinWorkLiveAtom({ environmentId, orgId }))
            .pipe(AsyncResult.value, Option.getOrNull)?.summary ?? null,
        ),
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when the page shows, and abandons what is in flight when it leaves
  useEffect(() => {
    list.start();
    return list.dispose;
  }, [list]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, and that the host is back, so it reads again only when the rows are behind
  useEffect(() => {
    if (!props.stale) list.changed(live.seq);
  }, [list, live.seq, props.stale]);

  const { filter } = listState;
  const overview = kinWorkOverview(live.summary, filter, names);
  const records = kinWorkShown(filter, listState.records, hostEdits).map((record) =>
    kinWorkApplied(record, changed),
  );
  const rows = records.map((record) => kinWorkRow(record, names, now));
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = records.find((held) => held.key === key);
    if (record !== undefined) void changes.run(record, action, names);
  };
  const nothing = kinWorkNothing(filter, names);
  const footer = kinWorkListFooter(filter, rows.length, listState.total, listState.more, hostEdits);
  return (
    // Hundreds of tasks stay cheap: only the rows in view mount.
    <LegendList<KinWorkRowView>
      data={rows}
      keyExtractor={(row) => row.key}
      extraData={[listState, changed]}
      recycleItems
      onEndReached={() => void list.loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.stale || listState.stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              {KIN_WORK_STALE}
            </p>
          ) : null}
          <KinWorkFilters
            overview={overview}
            filter={filter}
            onChange={(next) => list.setFilter(next)}
          />
          {changed.notice === null ? null : (
            <KinWorkListNotice
              notice={changed.notice}
              record={records.find((held) => held.key === changed.notice?.key) ?? null}
              onUndo={(record) => void changes.undo(record, names)}
              onDismiss={changes.dismiss}
            />
          )}
        </div>
      }
      ListEmptyComponent={
        <div className="mx-auto w-full max-w-3xl px-4">
          {listState.loading ? (
            <div role="status" aria-label="Loading tasks">
              <RowSkeletons />
            </div>
          ) : listState.failed !== null ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <Alert variant="error">
                <AlertDescription>{KIN_WORK_LOAD_FAILED}. Check your connection.</AlertDescription>
              </Alert>
              <Button size="sm" variant="outline" onClick={list.refresh}>
                Retry
              </Button>
            </div>
          ) : (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyTitle>{nothing.title}</EmptyTitle>
                <EmptyDescription>{nothing.detail}</EmptyDescription>
              </EmptyHeader>
              {nothing.offerNew && props.onAdd !== null ? (
                <EmptyContent>
                  <Button onClick={props.onAdd}>
                    <PlusIcon />
                    {KIN_WORK_NEW}
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          )}
        </div>
      }
      ListFooterComponent={
        footer === null ? null : (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3">
            <p className="text-xs text-muted-foreground" role="status">
              {listState.moreFailed ? "Couldn't load more." : footer}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={listState.loadingMore}
              aria-busy={listState.loadingMore}
              onClick={() => void list.loadMore()}
            >
              {listState.moreFailed ? "Try again" : "Show more"}
            </Button>
          </div>
        )
      }
      renderItem={({ item: row }) => (
        <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4">
          <KinWorkRow
            row={row}
            saving={changed.pending[row.key] !== undefined}
            onOpen={() => props.onOpen(row.key)}
            onAct={canChange ? (action) => act(row.key, action) : null}
          />
        </div>
      )}
      estimatedItemSize={60}
      drawDistance={640}
      className={cn(
        "min-h-0 flex-1 overscroll-contain pb-6",
        // Rows stay up while they are read again; dimming says they may be about to change.
        listState.refreshing && "opacity-70",
      )}
    />
  );
}

/** The overview and the filters in one: every count narrows the list to what it counts. */
function KinWorkFilters(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  readonly onChange: (filter: KinWorkFilter) => void;
}) {
  const { overview, filter } = props;
  return (
    <>
      <div className="-mx-1 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ToggleGroup
          variant="pill"
          size="sm"
          aria-label="Show"
          value={[filter.view]}
          onValueChange={(value) => {
            const view = overview.chips.find((chip) => chip.id === value[0]);
            if (view !== undefined) props.onChange({ ...filter, view: view.id });
          }}
        >
          {overview.chips.map((chip) => (
            <Toggle key={chip.id} value={chip.id} aria-label={chip.accessibilityLabel}>
              {chip.label}
              {chip.count === null ? null : (
                <span className="text-muted-foreground tabular-nums">{chip.count}</span>
              )}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {overview.owners.length === 0 ? null : (
        <ul aria-label="People and leads" className="grid gap-1 sm:grid-cols-2">
          {overview.owners.map((owner) => (
            <li key={owner.key}>
              <button
                type="button"
                aria-pressed={owner.selected}
                aria-label={`${owner.name}. ${owner.line}`}
                onClick={() =>
                  props.onChange({ ...filter, owner: owner.selected ? null : owner.owner })
                }
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-pressed:bg-accent"
              >
                <KinAvatar avatar={owner.avatar} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {owner.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {owner.line}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        type="search"
        aria-label={KIN_WORK_SEARCH_PLACEHOLDER}
        placeholder={KIN_WORK_SEARCH_PLACEHOLDER}
        value={filter.text}
        onChange={(event) => props.onChange({ ...filter, text: event.currentTarget.value })}
      />
    </>
  );
}

/** What the last change did, with the way back, said once above the rows. */
function KinWorkListNotice(props: {
  readonly notice: KinWorkNotice;
  /** The task as listed now; null once the list has moved on without it. */
  readonly record: KinRecord | null;
  readonly onUndo: (record: KinRecord) => void;
  readonly onDismiss: () => void;
}) {
  const { notice, record } = props;
  return (
    <Alert
      variant={notice.kind === "saved" ? "success" : notice.kind === "failed" ? "error" : "warning"}
    >
      <AlertDescription>
        {notice.key}: {notice.text}
      </AlertDescription>
      <AlertAction>
        {notice.undo === null || record === null ? null : (
          <Button size="xs" variant="outline" onClick={() => props.onUndo(record)}>
            {KIN_WORK_COPY.undo}
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={props.onDismiss}>
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}

const TICK_LABEL = { done: KIN_WORK_COPY.done, reopen: KIN_WORK_COPY.reopen } as const;

function KinWorkRow(props: {
  readonly row: KinWorkRowView;
  readonly saving: boolean;
  readonly onOpen: () => void;
  /** Null where this browser or this host can't change a task. */
  readonly onAct: ((action: KinWorkAction) => void) | null;
}) {
  const { row, onAct } = props;
  const tick = onAct === null ? null : row.tick;
  return (
    <div className="flex items-start gap-1 py-1" aria-busy={props.saving}>
      {tick === null || onAct === null ? (
        <span className="flex size-7 shrink-0 items-center justify-center pt-1.5">
          <KinWorkStateIcon state={row.state} />
        </span>
      ) : (
        <span className="pt-1.5">
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={props.saving}
            aria-label={`${TICK_LABEL[tick]}: ${row.title}`}
            title={TICK_LABEL[tick]}
            onClick={() => onAct({ type: "state", state: tick === "done" ? "done" : "open" })}
          >
            <KinWorkStateIcon state={row.state} />
          </Button>
        </span>
      )}
      <button
        type="button"
        aria-label={row.accessibilityLabel}
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-sm text-foreground">{row.title}</span>
          <span className="truncate text-xs text-muted-foreground">{row.line}</span>
        </span>
        {row.late ? (
          <Badge size="sm" variant="error">
            Late
          </Badge>
        ) : null}
      </button>
      {row.suggested && onAct !== null ? (
        <span className="flex shrink-0 items-center gap-1 pt-1.5">
          <Button
            size="xs"
            variant="ghost"
            disabled={props.saving}
            aria-label={`${KIN_WORK_COPY.decline}: ${row.title}`}
            onClick={() => onAct({ type: "decline" })}
          >
            {KIN_WORK_COPY.decline}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={props.saving}
            aria-label={`${KIN_WORK_COPY.keep}: ${row.title}`}
            onClick={() => onAct({ type: "confirm" })}
          >
            {KIN_WORK_COPY.keep}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
