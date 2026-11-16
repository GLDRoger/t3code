import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_SEARCH_PLACEHOLDER,
  KIN_WORK_STALE,
  kinWorkHostEdits,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOverview,
  kinWorkRow,
  kinWorkShown,
  type KinWorkFilter,
  type KinWorkNames,
  type KinWorkOverview,
  type KinWorkRef,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  kinWorkListNotice,
  type KinWorkAction,
  type KinWorkNotice as KinWorkNoticeState,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_WORK_LIST_INITIAL,
  createKinWorkList,
  type KinWorkListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import {
  KIN_WORK_HOME,
  kinWorkBesideNeedsYou,
  kinWorkFilterCleared,
  kinWorkFilterLabel,
  kinWorkOwnerSelected,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import {
  kinWorkGroupWithin,
  kinWorkGroups,
  kinWorkGroupsShown,
  type KinWorkGroupItem,
} from "@t3tools/client-runtime/kin/kinWorkGroups";
import { kinWorkListsMoved, type KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecord, KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  KinFilter,
  KinWorkNotice,
  KinWorkRowSkeletons,
  type KinFilterGroup,
  KinLoadFailed,
} from "./KinWorkParts";
import { KinAvatar } from "./KinAvatar";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { useKinMyDueTasks } from "./useKinPlaces";
import {
  kinWorkLiveAtom,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

/**
 * Tasks as a list: all of Work, or one project's under that project's own summary. Hundreds stay
 * cheap, because only the rows in view mount.
 */
export function KinWorkTaskList(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly changes: KinWorkChangesHandle;
    readonly openKey: KinRecordKey | null;
    readonly onOpen: (key: KinRecordKey) => void;
    readonly onAdd: (() => void) | null;
    /** Where the list starts: everything, or narrowed to a client or a project. */
    readonly initial: KinWorkFilter;
    /** The clients and projects to narrow to; null on a host without them. */
    readonly choices: KinWorkChoices | null;
    /** On a project's page the list is only that project's, under the project's own summary. */
    readonly within?: "project";
    readonly header?: React.ReactNode;
    /** What needs you, over the whole company's open tasks; those tasks then leave the list. */
    readonly renderNeedsYou?: (mine: ReadonlyArray<KinRecord> | null) => React.ReactNode;
  },
) {
  const { environmentId, orgId, live } = props;
  const { names } = props.directory;
  const { state: changed, changes } = props.changes;
  const hostEdits = kinWorkHostEdits(live.summary);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)) && hostEdits;
  const now = new Date(useNowMinuteMs());
  const [listState, setListState] = useState<KinWorkListState>(() => ({
    ...KIN_WORK_LIST_INITIAL,
    filter: props.initial,
  }));
  const [list] = useState(() =>
    createKinWorkList({
      orgId,
      initial: props.initial,
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
      rows: () =>
        appAtomRegistry
          .get(kinWorkLiveAtom({ environmentId, orgId }))
          .pipe(AsyncResult.value, Option.getOrNull)?.rows ?? null,
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
  const showsNeedsYou =
    props.renderNeedsYou !== undefined &&
    props.within === undefined &&
    kinWorkFilterLabel(filter, names) === null &&
    filter.text.trim() === "";
  const mine = useKinMyDueTasks(
    props,
    showsNeedsYou ? names.me : null,
    props.stale ? null : kinWorkListsMoved(live, ["work"]),
  );
  const beside = kinWorkBesideNeedsYou(records, showsNeedsYou ? mine : null);
  // The plain list reads by whom each task waits on; a filtered one stays one list.
  const items: ReadonlyArray<KinWorkGroupItem<KinRecord>> =
    props.within === undefined && kinWorkGroupsShown(filter, names.me)
      ? kinWorkGroups(beside, names)
      : beside.map((record) => ({ type: "task", key: record.key, record, section: null }));
  const rows: ReadonlyArray<KinWorkListItem> = items.map((item) =>
    item.type === "task"
      ? { ...item, row: kinWorkRow(item.record, names, now, kinWorkGroupWithin(item, filter)) }
      : item,
  );
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = records.find((held) => held.key === key);
    if (record !== undefined) void changes.run(record, action, names);
  };
  const notice = kinWorkListNotice(changed, props.openKey);
  const nothing = kinWorkNothing(filter, names);
  // Needs you shows the rest, so the count says how many are loaded in all.
  const footer = kinWorkListFooter(
    filter,
    records.length,
    listState.total,
    listState.more,
    hostEdits,
  );
  return (
    <LegendList<KinWorkListItem>
      data={rows}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.type}
      extraData={[listState, changed]}
      recycleItems
      onEndReached={() => void list.loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.header}
          {showsNeedsYou ? props.renderNeedsYou?.(mine) : null}
          {props.stale || listState.stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              {KIN_WORK_STALE}
            </p>
          ) : null}
          <KinWorkFilters
            overview={overview}
            filter={filter}
            names={names}
            choices={props.within === undefined ? props.choices : null}
            everyone={props.within === undefined}
            onChange={(next) => list.setFilter(next)}
          />
          {notice === null ? null : (
            <KinWorkListNotice
              notice={notice}
              onUndo={() =>
                void changes.undo(
                  names,
                  records.find((held) => held.key === notice.key),
                )
              }
              onDismiss={changes.dismiss}
            />
          )}
        </div>
      }
      ListEmptyComponent={
        // Every open task is already under Needs you.
        records.length > 0 ? null : (
          <div className="mx-auto w-full max-w-3xl px-4">
            {listState.loading ? (
              <div role="status" aria-label="Loading tasks">
                <KinWorkRowSkeletons />
              </div>
            ) : listState.failed !== null ? (
              <KinLoadFailed
                what={KIN_WORK_LOAD_FAILED}
                cause={listState.failed}
                onRetry={list.refresh}
                className="py-4"
              />
            ) : (
              <KinWorkNotice
                title={nothing.title}
                detail={nothing.detail}
                {...(nothing.offerNew && props.onAdd !== null
                  ? {
                      action: (
                        <Button onClick={props.onAdd}>
                          <PlusIcon />
                          {KIN_WORK_NEW}
                        </Button>
                      ),
                    }
                  : {})}
              />
            )}
          </div>
        )
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
              {listState.moreFailed ? KIN_RETRY : "Show more"}
            </Button>
          </div>
        )
      }
      renderItem={({ item }) =>
        item.type === "section" ? (
          <div className="mx-auto flex w-full max-w-3xl items-baseline gap-2 px-6 pt-5 pb-1">
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{item.title}</h3>
            <span className="text-xs text-muted-foreground tabular-nums">{item.count}</span>
          </div>
        ) : item.type === "who" ? (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 pt-2 pb-0.5">
            <KinAvatar avatar={item.avatar} size="xs" />
            <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
              {item.name}
            </span>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4">
            <KinWorkRow
              row={item.row}
              saving={changed.pending[item.key] !== undefined}
              selected={item.key === props.openKey}
              onOpen={() => props.onOpen(item.key)}
              onAct={canChange ? (action) => act(item.key, action) : null}
            />
          </div>
        )
      }
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

/** A line of the list: a part's heading, whom a run waits on, or a task with its row. */
type KinWorkListItem =
  | Exclude<KinWorkGroupItem<KinRecord>, { readonly type: "task" }>
  | (Extract<KinWorkGroupItem<KinRecord>, { readonly type: "task" }> & {
      readonly row: KinWorkRowView;
    });

const EVERYONE = "all";

/** Search, and the one Filter holding what to show, who has it, and which client or project. */
function KinWorkFilters(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  readonly names: KinWorkNames;
  readonly choices: KinWorkChoices | null;
  /** Whether to narrow by who has what across all of Work, which a project's own list doesn't. */
  readonly everyone: boolean;
  readonly onChange: (filter: KinWorkFilter) => void;
}) {
  const { overview, filter, choices } = props;
  // One it is already narrowed to stays pickable after it closes or passes the first hundred.
  const withHeld = (held: ReadonlyArray<KinWorkRef>, value: KinWorkRef | null) =>
    value === null || held.some((choice) => choice.key === value.key) ? held : [value, ...held];
  const clients = choices === null ? [] : withHeld(choices.clients, filter.party);
  const projects = choices === null ? [] : withHeld(choices.projects, filter.project);
  const owners = props.everyone ? overview.owners : [];
  const scope = (
    label: string,
    everything: string,
    held: ReadonlyArray<KinWorkRef>,
    value: KinWorkRef | null,
    set: (value: KinWorkRef | null) => KinWorkFilter,
  ): KinFilterGroup => ({
    label,
    long: true,
    value: value?.key ?? EVERYONE,
    options: [
      { value: EVERYONE, label: everything },
      ...held.map((choice) => ({ value: choice.key, label: choice.title })),
    ],
    onChange: (key) => props.onChange(set(held.find((choice) => choice.key === key) ?? null)),
  });
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <Input
          type="search"
          aria-label={KIN_WORK_SEARCH_PLACEHOLDER}
          placeholder={KIN_WORK_SEARCH_PLACEHOLDER}
          value={filter.text}
          onChange={(event) => props.onChange({ ...filter, text: event.currentTarget.value })}
        />
      </div>
      <KinFilter
        chip={kinWorkFilterLabel(filter, props.names)}
        onClear={() => props.onChange(kinWorkFilterCleared(filter))}
        groups={[
          {
            label: KIN_WORK_HOME.show,
            value: filter.view,
            options: overview.chips.map((chip) => ({
              value: chip.id,
              label: chip.label,
              detail: chip.count === null ? null : String(chip.count),
            })),
            onChange: (id) => {
              const view = overview.chips.find((chip) => chip.id === id);
              if (view !== undefined) props.onChange({ ...filter, view: view.id });
            },
          },
          {
            label: KIN_WORK_HOME.owner,
            long: true,
            value:
              owners.find((owner) => kinWorkOwnerSelected(filter, owner.owner))?.key ?? EVERYONE,
            options: [
              { value: EVERYONE, label: KIN_WORK_HOME.everyone },
              ...owners.map((owner) => ({
                value: owner.key,
                label: owner.name,
                detail: owner.line,
              })),
            ],
            onChange: (key) =>
              props.onChange({
                ...filter,
                owner: owners.find((owner) => owner.key === key)?.owner ?? null,
              }),
          },
          scope(
            KIN_WORK_HOME.byClient,
            KIN_WORK_HOME.allClients,
            clients,
            filter.party,
            (party) => ({
              ...filter,
              party,
            }),
          ),
          scope(
            KIN_WORK_HOME.byProject,
            KIN_WORK_HOME.allProjects,
            projects,
            filter.project,
            (project) => ({ ...filter, project }),
          ),
        ]}
      />
    </div>
  );
}

/** What the last change did, with the way back, said once above the rows. */
function KinWorkListNotice(props: {
  readonly notice: KinWorkNoticeState;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}) {
  const { notice } = props;
  return (
    <Alert
      variant={notice.kind === "saved" ? "success" : notice.kind === "failed" ? "error" : "warning"}
    >
      <AlertDescription>
        {notice.key}: {notice.text}
      </AlertDescription>
      <AlertAction>
        {notice.undo === null ? null : (
          <Button size="xs" variant="outline" onClick={props.onUndo}>
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

export function KinWorkRow(props: {
  readonly row: KinWorkRowView;
  readonly saving: boolean;
  /** The task open over the list. */
  readonly selected?: boolean;
  readonly onOpen: () => void;
  /** Null where this browser or this host can't change a task. */
  readonly onAct: ((action: KinWorkAction) => void) | null;
}) {
  const { row, onAct } = props;
  const tick = onAct === null ? null : row.tick;
  return (
    <div className="flex items-start gap-1 py-1" aria-busy={props.saving}>
      {tick === null || onAct === null ? (
        <span className="mt-1.5 flex size-7 shrink-0 items-center justify-center sm:size-6">
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
        aria-current={props.selected === true ? true : undefined}
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-sm text-foreground">{row.title}</span>
          {/* Who has it never gives way: the rest of the line cuts off before it does. */}
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <KinAvatar avatar={row.ownerAvatar} size="xs" />
            <span className="max-w-[60%] shrink-0 truncate text-foreground/80">{row.holder}</span>
            {row.detail === "" ? null : (
              <span className="min-w-0 truncate">
                <span aria-hidden>· </span>
                {row.detail}
              </span>
            )}
          </span>
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
