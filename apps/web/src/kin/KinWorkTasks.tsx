import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_NEW_COPY,
  KIN_WORK_SEARCH_PLACEHOLDER,
  KIN_WORK_STALE,
  kinWorkHostEdits,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOverview,
  kinWorkRow,
  kinWorkShown,
  type KinWorkFilter,
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
import { KIN_CLIENTS, KIN_PROJECTS } from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinAvatar } from "./KinAvatar";
import { KinWorkNotice, KinWorkRowSkeletons } from "./KinWorkParts";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
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
  const rows = records.map((record) => kinWorkRow(record, names, now, filter));
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = records.find((held) => held.key === key);
    if (record !== undefined) void changes.run(record, action, names);
  };
  const notice = kinWorkListNotice(changed, props.openKey);
  const nothing = kinWorkNothing(filter, names);
  const footer = kinWorkListFooter(filter, rows.length, listState.total, listState.more, hostEdits);
  return (
    <LegendList<KinWorkRowView>
      data={rows}
      keyExtractor={(row) => row.key}
      extraData={[listState, changed]}
      recycleItems
      onEndReached={() => void list.loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.header}
          {props.stale || listState.stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              {KIN_WORK_STALE}
            </p>
          ) : null}
          <KinWorkFilters
            overview={overview}
            filter={filter}
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
        <div className="mx-auto w-full max-w-3xl px-4">
          {listState.loading ? (
            <div role="status" aria-label="Loading tasks">
              <KinWorkRowSkeletons />
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

const EVERYONE = "all";

/** Narrows the list to one client or one project, from the ones there are. */
function ScopeSelect(props: {
  readonly label: string;
  readonly everything: string;
  readonly choices: ReadonlyArray<KinWorkRef>;
  readonly value: KinWorkRef | null;
  readonly onChange: (value: KinWorkRef | null) => void;
}) {
  // One it is already narrowed to stays pickable after it closes or passes the first hundred.
  const choices =
    props.value === null || props.choices.some((choice) => choice.key === props.value?.key)
      ? props.choices
      : [props.value, ...props.choices];
  return (
    <Select
      value={props.value?.key ?? EVERYONE}
      onValueChange={(value) =>
        props.onChange(choices.find((choice) => choice.key === value) ?? null)
      }
    >
      <SelectTrigger className="w-full min-w-0 sm:w-44" aria-label={props.label}>
        <SelectValue>{props.value?.title ?? props.everything}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value={EVERYONE}>{props.everything}</SelectItem>
        {choices.map((choice) => (
          <SelectItem key={choice.key} value={choice.key}>
            {choice.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The overview and the filters in one: every count narrows the list to what it counts. */
function KinWorkFilters(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  readonly choices: KinWorkChoices | null;
  /** Whether to show who has what across all of Work, which a project's own list doesn't. */
  readonly everyone: boolean;
  readonly onChange: (filter: KinWorkFilter) => void;
}) {
  const { overview, filter, choices } = props;
  const narrowing =
    choices !== null &&
    (choices.clients.length > 0 ||
      choices.projects.length > 0 ||
      filter.party !== null ||
      filter.project !== null);
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
      {overview.owners.length === 0 || !props.everyone ? null : (
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
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <Input
            type="search"
            aria-label={KIN_WORK_SEARCH_PLACEHOLDER}
            placeholder={KIN_WORK_SEARCH_PLACEHOLDER}
            value={filter.text}
            onChange={(event) => props.onChange({ ...filter, text: event.currentTarget.value })}
          />
        </div>
        {narrowing ? (
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <ScopeSelect
              label={KIN_WORK_NEW_COPY.clientLabel}
              everything={KIN_CLIENTS.all}
              choices={choices.clients}
              value={filter.party}
              onChange={(party) => props.onChange({ ...filter, party })}
            />
            <ScopeSelect
              label={KIN_WORK_NEW_COPY.projectLabel}
              everything={KIN_PROJECTS.all}
              choices={choices.projects}
              value={filter.project}
              onChange={(project) => props.onChange({ ...filter, project })}
            />
          </div>
        ) : null}
      </div>
    </>
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
