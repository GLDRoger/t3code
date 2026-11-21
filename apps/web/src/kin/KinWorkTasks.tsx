import { useKinOwnerLevel, useKinViewerScope } from "./useKinOwnerLevel";
import { KIN_MORE_FAILED, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_TASK_GROUP_BY,
  kinTaskFilterProjects,
  KIN_TASKS,
  kinNeedsYouCount,
  kinTaskGroupedChip,
  kinTaskLine,
  kinTaskStep,
  kinTaskStepStatusShown,
  kinTasksByMove,
  kinTasksDealFacts,
  kinTasksGroupedBy,
  type KinTaskLine,
  type KinTaskStep,
  type KinTasksItem,
} from "@t3tools/client-runtime/kin/kinTasksList";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_SEARCH_PLACEHOLDER,
  kinWorkByMove,
  kinWorkHostEdits,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOverview,
  kinWorkRow,
  kinWorkShown,
  type KinTaskGroupBy,
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
  createKinListKeeper,
  createKinWorkList,
  type KinWorkList,
  type KinWorkListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import {
  KIN_WORK_HOME,
  kinWorkFilterCleared,
  kinWorkFilterLabel,
  kinWorkOwnerSelected,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { KinRecordKey, type KinRecord } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  BellIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  FileTextIcon,
  MessageSquareTextIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  KinFilter,
  KinWorkNotice,
  KinWorkRowSkeletons,
  type KinFilterGroup,
  KinLoadFailed,
  KinWorkStaleLine,
} from "./KinWorkParts";
import { KinAttentionItem } from "./KinAttention";
import { KinAvatar } from "./KinAvatar";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { useKinAttention, useKinAttentionHandle } from "./useKinAttention";
import { useKinTaskSteps, type KinTaskStepStatus } from "./useKinTaskSteps";
import {
  kinWorkLiveAtom,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

/** Task lists kept while their screen is away, so coming back reads nothing the stream brought. */
const kinTaskLists = createKinListKeeper<KinWorkList, KinWorkListState>(Date.now);

/** How Tasks groups, kept on this device as the phone keeps it. */
const GROUP_BY_KEY = "kin:tasks:groupBy";
const GroupBySchema = Schema.Literals(["me", "project", "person", "due", "status"]);

/** Marked done or reopened from a row: the way back stays this long, as on the phone. */
const UNDO_MS = 8_000;

/** A project's heading in Tasks, which opens the project. */
function ProjectHeading(props: {
  readonly title: string;
  readonly project: KinRecordKey;
  readonly onOpen: (key: KinRecordKey) => void;
}) {
  return (
    <h3 className="-ms-2 min-w-0">
      <Button size="xs" variant="ghost" onClick={() => props.onOpen(props.project)}>
        <span className="truncate">{props.title}</span>
      </Button>
    </h3>
  );
}

/**
 * Tasks as a list: all of Work grouped by whose move each is (or by one of its own fields), or one
 * project's under that project's own summary. Hundreds stay cheap: only the rows in view mount.
 */
export function KinWorkTaskList(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly changes: KinWorkChangesHandle;
    readonly openKey: KinRecordKey | null;
    readonly onOpen: (key: KinRecordKey) => void;
    /** A project's heading opens the project; absent where headings stay plain. */
    readonly onOpenProject?: (key: KinRecordKey) => void;
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
  const { environmentId, orgId, live, within } = props;
  const navigate = useNavigate();
  const scope = useKinViewerScope(environmentId);
  const { names } = props.directory;
  const { state: changed, changes } = props.changes;
  const hostEdits = kinWorkHostEdits(live.summary);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)) && hostEdits;
  const canAnswer = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const canNudge = useAtomValue(kinClient.workNudge.permissionAtom(environmentId));
  const now = new Date(useNowMinuteMs());
  const [savedGroupBy, saveGroupBy] = useLocalStorage<KinTaskGroupBy, KinTaskGroupBy>(
    GROUP_BY_KEY,
    "me",
    GroupBySchema,
  );
  // All of Work groups; a project's own list stays one list.
  const [initial] = useState(() =>
    within === undefined ? { ...props.initial, groupBy: savedGroupBy } : props.initial,
  );
  const [kept] = useState(() =>
    kinTaskLists.take(
      `${environmentId}\u0000${orgId}\u0000${JSON.stringify(initial)}`,
      (onChange) =>
        createKinWorkList({
          orgId,
          initial,
          read: (input) => kinClient.workList.run(appAtomRegistry, { environmentId, input }),
          onChange,
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
    ),
  );
  const list = kept.list;
  const [resumed] = useState(() => kinTaskLists.wasKept(kept));
  const [listState, setListState] = useState<KinWorkListState>(() =>
    resumed ? list.getState() : { ...KIN_WORK_LIST_INITIAL, filter: initial },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when the page shows (or catches a kept one up), and stops what is in flight when it leaves
  useEffect(() => {
    kinTaskLists.show(kept, setListState);
    if (resumed) list.resume();
    else list.start();
    return () => kinTaskLists.hide(kept);
  }, [kept, list, resumed]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, and that the host is back, so it reads again only when the rows are behind
  useEffect(() => {
    if (!props.stale) list.changed(live.seq);
  }, [list, live.seq, props.stale]);

  const { filter } = listState;
  const setFilter = (next: KinWorkFilter) => {
    if (next.groupBy !== undefined && next.groupBy !== filter.groupBy) saveGroupBy(next.groupBy);
    list.setFilter(next);
  };
  const overview = kinWorkOverview(live.summary, filter, names);
  const records = kinWorkShown(filter, listState.records, hostEdits).map((record) =>
    kinWorkApplied(record, changed),
  );
  const ownerLevel = useKinOwnerLevel(environmentId);
  const pulse = useKinAttention({ environmentId, orgId }, within === undefined);
  const facts = kinTasksDealFacts({ ownerLevel, names, now, pulse });
  const counts = list.counts();
  // The same number the nav's Tasks count shows (`useKinTasksNeedsYou`).
  const needsYou = kinNeedsYouCount({ counts, dealFacts: facts.length });
  const groupBy = filter.groupBy ?? "me";
  const searching = within === undefined && filter.text.trim() !== "";
  const items: ReadonlyArray<KinTasksItem<KinRecord>> =
    within === undefined && kinWorkByMove(filter)
      ? kinTasksByMove({
          records,
          moves: list.moves(),
          counts,
          needsYou,
          ownerLevel,
          names,
          facts,
        })
      : within === undefined && groupBy !== "me" && !searching
        ? kinTasksGroupedBy({ records, groupBy, summary: live.summary, names, now })
        : records.map((record, index) => ({
            type: "task" as const,
            key: record.key,
            record,
            move: null,
            inProject: within !== undefined,
            first: index === 0,
            last: index === records.length - 1,
          }));
  const steps = useKinTaskSteps({ environmentId, orgId });
  const answers = useKinAttentionHandle({ environmentId, orgId });
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = records.find((held) => held.key === key);
    if (record !== undefined) void changes.run(record, action, names);
  };
  const openCard = (step: KinTaskStep) => {
    if (step.kind === "nudge") return;
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { environmentId, orgId, chatId: step.card.chatId },
      search: { message: step.card.messageId },
    });
  };
  const notice = kinWorkListNotice(changed, props.openKey);
  const nothing = kinWorkNothing(filter, names, scope);
  const footer = kinWorkListFooter(
    filter,
    records.length,
    listState.total,
    listState.more,
    hostEdits,
  );
  const grouped = kinTaskGroupedChip(within === undefined ? filter.groupBy : undefined);
  return (
    <>
      <LegendList<KinTasksItem<KinRecord>>
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        extraData={[listState, changed, steps.status, steps.nudged, needsYou, answers.busy]}
        recycleItems
        onEndReached={() => void list.loadMore()}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
            {props.header}
            {props.stale || listState.stale ? (
              <KinWorkStaleLine environmentId={environmentId} onRetry={list.refresh} />
            ) : null}
            <KinWorkFilters
              overview={overview}
              filter={filter}
              names={names}
              choices={within === undefined ? props.choices : null}
              records={records}
              everyone={within === undefined}
              grouped={grouped}
              onChange={setFilter}
            />
            {notice === null || notice.undo !== null ? null : (
              <KinWorkListNotice notice={notice} onDismiss={changes.dismiss} />
            )}
            {answers.problem === null ? null : (
              <p role="alert" className="px-2 text-xs text-destructive-foreground">
                {answers.problem}
              </p>
            )}
          </div>
        }
        ListEmptyComponent={
          records.length > 0 || items.length > 0 ? null : (
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
                {listState.moreFailed ? KIN_MORE_FAILED : footer}
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
        renderItem={({ item }) => {
          switch (item.type) {
            case "heading":
              return (
                <div className="mx-auto flex w-full max-w-3xl items-baseline gap-2 px-6 pt-5 pb-1">
                  {item.project === null || props.onOpenProject === undefined ? (
                    <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
                      {item.title}
                    </h3>
                  ) : (
                    <ProjectHeading
                      title={item.title}
                      project={KinRecordKey.make(item.project.key)}
                      onOpen={props.onOpenProject}
                    />
                  )}
                  {item.count === null ? null : (
                    <span className="text-xs text-muted-foreground tabular-nums">{item.count}</span>
                  )}
                  {item.aside === null ? null : (
                    <span className="ms-auto shrink-0 truncate text-xs text-muted-foreground">
                      {item.aside}
                    </span>
                  )}
                </div>
              );
            case "clear":
              return (
                <div className="mx-auto w-full max-w-3xl px-4">
                  <div className="flex items-start gap-3 rounded-md px-2 py-3">
                    <CircleCheckIcon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {KIN_TASKS.clearTitle}
                      </span>
                      <span className="text-xs text-muted-foreground">{KIN_TASKS.clearDetail}</span>
                    </span>
                  </div>
                </div>
              );
            case "done":
              return (
                <div className="mx-auto w-full max-w-3xl px-4 pt-4">
                  <button
                    type="button"
                    onClick={() => setFilter({ ...filter, view: "closed" })}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                  >
                    <CircleCheckIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {KIN_TASKS.done}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">{item.count}</span>
                    <ChevronRightIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </button>
                </div>
              );
            case "foot":
              return (
                <p className="mx-auto w-full max-w-3xl px-6 pt-3 text-xs text-muted-foreground">
                  {item.text}
                </p>
              );
            case "fact":
              return (
                <ul className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1.5">
                  <KinAttentionItem
                    environmentId={environmentId}
                    orgId={orgId}
                    row={item.row}
                    handler={answers}
                    onOpen={(to) => (to.type === "record" ? props.onOpen(to.key) : undefined)}
                  />
                </ul>
              );
            case "task": {
              const { record } = item;
              const step = kinTaskStep(record, item.move, names);
              const shown =
                step?.kind === "nudge" && steps.nudged.has(record.key)
                  ? { ...step, nudged: true }
                  : step;
              return (
                <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4">
                  <KinTaskRow
                    row={kinWorkRow(
                      record,
                      names,
                      now,
                      item.inProject ? { ...filter, project: record.project ?? null } : filter,
                    )}
                    line={kinTaskLine(record, names, now, {
                      inProject: item.inProject,
                      quietNoDate: shown !== null,
                    })}
                    step={shown}
                    status={kinTaskStepStatusShown(steps.status[record.key], shown)}
                    saving={changed.pending[item.key] !== undefined}
                    selected={item.key === props.openKey}
                    onOpen={() => props.onOpen(record.key)}
                    onAct={canChange ? (action) => act(record.key, action) : null}
                    onChoose={
                      canAnswer && shown !== null && shown.kind !== "nudge"
                        ? (optionId) => void steps.choose(record.key, shown, optionId)
                        : null
                    }
                    onOpenCard={() => (shown === null ? undefined : openCard(shown))}
                    onNudge={canNudge ? () => void steps.nudge(record.key) : null}
                    onGive={() => props.onOpen(record.key)}
                  />
                </div>
              );
            }
          }
        }}
        estimatedItemSize={60}
        drawDistance={640}
        className={cn(
          "min-h-0 flex-1 overscroll-contain pb-6",
          // Rows stay up while they are read again; dimming says they may be about to change.
          listState.refreshing && "opacity-70",
        )}
      />
      {notice === null || notice.undo === null ? null : (
        <KinTasksUndoToast
          key={`${notice.key}:${notice.text}`}
          text={`${notice.key}: ${notice.text}`}
          onUndo={() =>
            void changes.undo(
              names,
              records.find((held) => held.key === notice.key),
            )
          }
          onDismiss={changes.dismiss}
        />
      )}
    </>
  );
}

/** The way back from marking a task done or reopening it, for eight seconds, in the toast. */
function KinTasksUndoToast(props: {
  readonly text: string;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}) {
  const { text, onDismiss } = props;
  const onUndo = useStableCallback(props.onUndo);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows the change in the app's toast with its Undo, and takes it away when the list's notice goes
  useEffect(() => {
    const toast = toastManager.add({
      type: "success",
      title: text,
      timeout: UNDO_MS,
      data: { onClose: onDismiss },
      actionProps: {
        children: KIN_WORK_COPY.undo,
        onClick: () => {
          toastManager.close(toast);
          onUndo();
        },
      },
    });
    const timer = setTimeout(onDismiss, UNDO_MS);
    return () => {
      clearTimeout(timer);
      toastManager.close(toast);
    };
  }, [text, onUndo, onDismiss]);
  return null;
}

const TICK_LABEL = { done: KIN_WORK_COPY.done, reopen: KIN_WORK_COPY.reopen } as const;

const LEAD_TONE = {
  late: "text-destructive-foreground",
  soon: "text-warning-foreground",
  working: "text-update-foreground",
} as const;

/**
 * One task in Tasks: the circle that marks it done, the title on at most two lines, who has it
 * and one coloured word, and its one step with that step's buttons, each reachable by Tab.
 */
function KinTaskRow(props: {
  readonly row: KinWorkRowView;
  readonly line: KinTaskLine;
  readonly step: KinTaskStep | null;
  readonly status: KinTaskStepStatus | null;
  readonly saving: boolean;
  readonly selected: boolean;
  readonly onOpen: () => void;
  /** Null where this browser or this host can't change a task. */
  readonly onAct: ((action: KinWorkAction) => void) | null;
  /** Null where this browser can't answer a card. */
  readonly onChoose: ((optionId: string) => void) | null;
  readonly onOpenCard: () => void;
  /** Null where this browser can't nudge. */
  readonly onNudge: (() => void) | null;
  readonly onGive: () => void;
}) {
  const { row, line, step, status, onAct } = props;
  const tick = onAct === null ? null : row.tick;
  const tail = line.lead !== null || line.rest !== "";
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
            // The second click of a double click would land on the flipped circle and undo it.
            onClick={(event) =>
              event.detail > 1
                ? undefined
                : onAct({ type: "state", state: tick === "done" ? "done" : "open" })
            }
          >
            <KinWorkStateIcon state={row.state} />
          </Button>
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-1">
        <button
          type="button"
          aria-label={row.accessibilityLabel}
          aria-current={props.selected ? true : undefined}
          // Where focus goes back to when the task it opened closes.
          data-kin-row={row.key}
          onClick={props.onOpen}
          className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent"
        >
          <span className="line-clamp-2 text-sm text-foreground">{row.title}</span>
          {/* Who has it never gives way: the rest of the line cuts off before it does. */}
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <KinAvatar avatar={row.ownerAvatar} size="xs" />
            <span className="max-w-[60%] shrink-0 truncate text-foreground/80">{line.holder}</span>
            {tail ? (
              <span className="min-w-0 truncate">
                <span aria-hidden>· </span>
                {line.lead === null ? null : (
                  <span className={cn("font-medium", LEAD_TONE[line.lead.tone])}>
                    {line.lead.text}
                  </span>
                )}
                {line.lead !== null && line.rest !== "" ? " · " : null}
                {line.rest}
              </span>
            ) : null}
          </span>
        </button>
        {step === null || step.line === null ? null : (
          <p className="flex min-w-0 items-start gap-1.5 px-2 text-xs text-foreground">
            {step.kind === "send" ? (
              <FileTextIcon aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <MessageSquareTextIcon
                aria-hidden
                className="mt-px size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="line-clamp-2 min-w-0">{step.line}</span>
          </p>
        )}
        {step?.kind !== "send" || step.mayHaveGone === null ? null : (
          <p className="px-2 text-xs font-medium text-destructive-foreground">{step.mayHaveGone}</p>
        )}
        {step === null ? null : status?.kind === "done" ? (
          <p role="status" className="px-2 text-xs font-medium text-foreground">
            {status.text}
          </p>
        ) : (
          <div className="flex flex-col gap-1 px-2">
            <KinTaskStepButtons
              step={step}
              title={row.title}
              busyId={status?.kind === "busy" ? status.id : null}
              onChoose={props.onChoose}
              onOpenCard={props.onOpenCard}
              onNudge={props.onNudge}
              onGive={props.onGive}
            />
            {status?.kind === "failed" ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {status.text}
              </p>
            ) : null}
          </div>
        )}
      </div>
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

function KinTaskStepButtons(props: {
  readonly step: KinTaskStep;
  readonly title: string;
  readonly busyId: string | null;
  readonly onChoose: ((optionId: string) => void) | null;
  readonly onOpenCard: () => void;
  readonly onNudge: (() => void) | null;
  readonly onGive: () => void;
}) {
  const { step, busyId, onChoose } = props;
  const busy = busyId !== null;
  const label = (what: string) => `${what}: ${props.title}`;
  if (step.kind === "nudge") {
    const nudgeText = step.nudged ? KIN_TASKS.nudged : KIN_TASKS.nudge(step.name);
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {props.onNudge === null && !step.nudged ? null : (
          <Button
            size="xs"
            variant="outline"
            aria-label={label(nudgeText)}
            aria-busy={busyId === "nudge"}
            disabled={busy || step.nudged || props.onNudge === null}
            onClick={props.onNudge ?? undefined}
          >
            {step.nudged ? <CheckIcon aria-hidden /> : <BellIcon aria-hidden />}
            {nudgeText}
          </Button>
        )}
        {step.give ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={label(KIN_TASKS.giveTo)}
            disabled={busy}
            onClick={props.onGive}
          >
            {KIN_TASKS.giveTo}
          </Button>
        ) : null}
      </div>
    );
  }
  if (step.kind === "send") {
    const { approve } = step;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {approve === null || onChoose === null ? null : (
          <Button
            size="xs"
            aria-label={label(KIN_TASKS.approve)}
            aria-busy={busyId === approve.optionId}
            disabled={busy}
            onClick={() => onChoose(approve.optionId)}
          >
            <CheckIcon aria-hidden />
            {KIN_TASKS.approve}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          aria-label={label(KIN_TASKS.review)}
          disabled={busy}
          onClick={props.onOpenCard}
        >
          {KIN_TASKS.review}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={step.line}>
      {onChoose === null
        ? null
        : step.options.map((option) => (
            <Button
              key={option.optionId}
              size="xs"
              variant="outline"
              title={KIN_TASKS.replyHint}
              aria-busy={busyId === option.optionId}
              disabled={busy}
              onClick={() => onChoose(option.optionId)}
            >
              {option.label}
            </Button>
          ))}
      <Button
        size="xs"
        variant="ghost"
        aria-label={label(KIN_TASKS.other)}
        disabled={busy}
        onClick={props.onOpenCard}
      >
        {KIN_TASKS.other}
      </Button>
    </div>
  );
}

const EVERYONE = "all";

/** Search, and the one Filter holding what to show, who has it, and which client or project. */
function KinWorkFilters(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  readonly names: KinWorkNames;
  readonly choices: KinWorkChoices | null;
  /** The rows in view, whose projects the Filter offers too. */
  readonly records: ReadonlyArray<KinRecord>;
  /** Whether to narrow by who has what across all of Work, which a project's own list doesn't. */
  readonly everyone: boolean;
  /** The chip saying the list is grouped some other way than Me first; null when it isn't. */
  readonly grouped: string | null;
  readonly onChange: (filter: KinWorkFilter) => void;
}) {
  const { overview, filter, choices } = props;
  // One it is already narrowed to stays pickable after it closes or passes the first hundred.
  const withHeld = (held: ReadonlyArray<KinWorkRef>, value: KinWorkRef | null) =>
    value === null || held.some((choice) => choice.key === value.key) ? held : [value, ...held];
  const clients = choices === null ? [] : withHeld(choices.clients, filter.party);
  const projects =
    choices === null
      ? []
      : withHeld(kinTaskFilterProjects(choices.projects, props.records), filter.project);
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
        grouped={
          props.grouped === null
            ? null
            : { label: props.grouped, onClear: () => props.onChange({ ...filter, groupBy: "me" }) }
        }
        groups={[
          // Only all of Work groups; a project's own list leaves Group by out.
          ...(props.everyone
            ? [
                {
                  label: KIN_TASKS.groupBy,
                  value: filter.groupBy ?? "me",
                  options: KIN_TASK_GROUP_BY.map((one) => ({ value: one.id, label: one.label })),
                  onChange: (id: string) => {
                    const one = KIN_TASK_GROUP_BY.find((option) => option.id === id);
                    if (one !== undefined) props.onChange({ ...filter, groupBy: one.id });
                  },
                  // Said once, here: the order never changes.
                  note: KIN_TASKS.order,
                } satisfies KinFilterGroup,
              ]
            : []),
          {
            label: props.everyone ? KIN_TASKS.showOnly : KIN_WORK_HOME.show,
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

/** A change that failed or was refused, said once above the rows; the way back is the toast's. */
function KinWorkListNotice(props: {
  readonly notice: KinWorkNoticeState;
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
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={props.onDismiss}>
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}

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
            // The second click of a double click would land on the flipped circle and undo it.
            onClick={(event) =>
              event.detail > 1
                ? undefined
                : onAct({ type: "state", state: tick === "done" ? "done" : "open" })
            }
          >
            <KinWorkStateIcon state={row.state} />
          </Button>
        </span>
      )}
      <button
        type="button"
        aria-label={row.accessibilityLabel}
        aria-current={props.selected === true ? true : undefined}
        // Where focus goes back to when the task it opened closes.
        data-kin-row={row.key}
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
        {row.markText === null ? null : (
          <Badge
            size="sm"
            variant={
              row.mark === "late" ? "error" : row.mark === "handed_back" ? "secondary" : "warning"
            }
          >
            {row.markText}
          </Badge>
        )}
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
