import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinHostLink } from "@t3tools/client-runtime/kin/kinHost";
import { KIN_MORE_FAILED, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_SEARCH } from "@t3tools/client-runtime/kin/kinDocs";
import {
  KIN_TASK_FILTER,
  KIN_TASK_GROUP_BY,
  KIN_TASK_MORE_VIEWS,
  kinTaskFilterProjects,
  kinTaskQuickFilters,
  kinTasksOnCount,
  KIN_TASKS,
  kinNeedsYouCount,
  kinTaskGroupedChip,
  kinTaskLine,
  kinTaskStep,
  kinTaskStepStatusShown,
  kinTasksByMove,
  kinTasksDealFacts,
  kinTasksGroupedBy,
  kinTasksSharedAbout,
  kinTasksTick,
  kinTasksTickedShown,
  kinTasksWithTicked,
  type KinTaskTicked,
  type KinTasksItem,
} from "@t3tools/client-runtime/kin/kinTasksList";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_SEARCH_PLACEHOLDER,
  kinWorkAvatar,
  kinWorkByMove,
  kinWorkHostEdits,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOffline,
  kinWorkOverview,
  kinWorkRow,
  kinWorkShown,
  type KinWorkFilter,
  type KinWorkNames,
  type KinWorkOverview,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  kinWorkListNotice,
  type KinWorkAction,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_WORK_HOME,
  kinWorkAskDraft,
  kinWorkFilterCleared,
  kinWorkFilterLabel,
  kinWorkOwnerSelected,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import {
  KIN_WORK_LIST_INITIAL,
  createKinListKeeper,
  createKinWorkList,
  kinListShown,
  type KinWorkList,
  type KinWorkListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecord, KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Toast } from "../../components/ui/Toast";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinAttentionItem } from "./KinAttention";
import { KinSearchHits } from "./KinDocsList";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";
import { kinTabBar, useKinTab, kinTabFoot } from "./components/KinTab";
import {
  KinTaskRow,
  KinTasksAllClear,
  KinWorkStaleNotice,
  KinWorkToggleRow,
  kinCardCorners,
} from "./components/KinWorkPieces";
import { useKinViewerScope } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { kinTaskLeftAtom } from "./state/kinTaskLeft";
import { useKinOpenHit, useKinWorkLink } from "./state/kinWorkLink";
import { useKinSearch } from "./state/useKinDocs";
import { useKinAskAgent } from "./state/useKinMoney";
import { useKinAttention, useKinAttentionHandle } from "./state/useKinAttention";
import { useKinHostAt } from "./state/useKinHost";
import { useKinTaskSteps } from "./state/useKinTaskSteps";
import {
  kinWorkLiveAtom,
  refreshKinWorkLive,
  useKinWorkChanges,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

/** Task lists kept while their screen is away, so coming back reads nothing the stream brought. */
const kinTaskLists = createKinListKeeper<KinWorkList, KinWorkListState>(Date.now);

/** What the Tasks search finds besides tasks, which the list itself already narrows to; deals are asked beside them. */
const ELSEWHERE = ["clients", "contacts", "projects", "docs"] as const;

/** Tasks, a screenful at a time: grouped by whose move, by one of its fields, or one project's. */
export function KinTasksList(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly title: string;
    /** A project's page goes back to where it was opened from; a tab has no Back. */
    readonly onBack?: () => void;
    /** What the list can be narrowed to; null on an older server, or inside a project. */
    readonly choices: KinWorkChoices | null;
    readonly initial: KinWorkFilter;
    /** A project's page: its summary heads the list, which stays narrowed to it. */
    readonly within?: {
      readonly header: React.ReactNode;
      readonly bar: Pick<React.ComponentProps<typeof AppBar>, "actions" | "menus">;
    };
  },
) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const openRecord = useKinWorkLink();
  const openHit = useKinOpenHit(props);
  const { environmentId, orgId, live } = props;
  const { names } = props.directory;
  const canAdd = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const canAnswer = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const canNudge = useAtomValue(kinClient.workNudge.permissionAtom(environmentId));
  const { state: changed, changes } = useKinWorkChanges(props);
  const agent = useKinAskAgent(props, "tasks");
  const hostEdits = kinWorkHostEdits(live.summary);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)) && hostEdits;
  const now = new Date(useNowMinuteMs());
  const viewer =
    useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId))?.personId ?? null;
  const [kept] = useState(() =>
    kinTaskLists.take(
      `${environmentId}\u0000${orgId}\u0000${JSON.stringify(props.initial)}`,
      (onChange) =>
        createKinWorkList({
          orgId,
          initial: props.initial,
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
      viewer,
    ),
  );
  const list = kept.list;
  const [resumed] = useState(() => kinTaskLists.wasKept(kept));
  const [listState, setListState] = useState<KinWorkListState>(() =>
    resumed ? list.getState() : { ...KIN_WORK_LIST_INITIAL, filter: props.initial },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when the screen shows (or catches a kept one up), and stops what is in flight when it leaves
  useEffect(() => {
    kinTaskLists.show(kept, setListState);
    if (resumed) kinTaskLists.resume(kept);
    else list.start();
    return () => kinTaskLists.hide(kept);
  }, [kept, list, resumed]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, and that the host is back, so it reads again only when the rows are behind
  useEffect(() => {
    if (!props.stale) list.changed(live.seq);
  }, [list, live.seq, props.stale]);

  const refresh = () => {
    refreshKinWorkLive({ environmentId, orgId });
    list.refresh();
  };
  const { filter } = listState;
  const shown = kinListShown(listState, kinHostLink(useKinHostAt(environmentId)));
  const scope = useKinViewerScope(environmentId);
  const overview = kinWorkOverview(
    live.summary,
    filter,
    names,
    kinTasksOnCount(listState.records, names.me),
  );
  const records = kinWorkShown(filter, listState.records, hostEdits).map((record) =>
    kinWorkApplied(record, changed),
  );
  const notice = kinWorkListNotice(changed, null);
  const leftAt = useAtomValue(kinTaskLeftAtom);
  const left =
    leftAt !== null && leftAt.environmentId === environmentId && leftAt.orgId === orgId
      ? leftAt
      : null;
  const [ticked, setTicked] = useState<ReadonlyArray<KinTaskTicked<KinRecord>>>([]);
  const held = kinTasksTickedShown(ticked, changed, notice);
  // A project's own list is always its project's, so only the rest of the filter is a chip.
  const narrowed = kinWorkFilterLabel(
    props.within === undefined ? filter : { ...filter, party: null, project: null },
    names,
  );
  const ownerLevel = useAtomValue(kinOwnerLevelAtom(connectionAtomRuntime, environmentId));
  const { within } = props;
  const pulse = useKinAttention({ environmentId, orgId }, within === undefined);
  const facts = kinTasksDealFacts({ ownerLevel, names, now, pulse });
  const answers = useKinAttentionHandle({ environmentId, orgId });
  const counts = list.counts();
  // The same number the dock's Tasks badge shows (`useKinTasksNeedsYou`).
  const needsYou = kinNeedsYouCount({ counts, dealFacts: facts.length });
  const groupBy = filter.groupBy ?? "me";
  const searching = within === undefined && filter.text.trim() !== "";
  const listed: ReadonlyArray<KinTasksItem<KinRecord>> =
    within === undefined && kinWorkByMove(filter)
      ? kinTasksByMove({
          records,
          moves: list.moves(),
          counts,
          needsYou,
          ownerLevel,
          names,
          facts,
          read: listState.seq !== null,
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
  const items =
    shown !== "rows"
      ? []
      : kinTasksWithTicked(listed, held, (record) => kinWorkApplied(record, changed));
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const shown = items.find((item) => item.type === "task" && item.key === key);
    if (shown?.type !== "task") return;
    const tick = kinTasksTick({ held, items, key, action, notice });
    if (tick.undo) return void changes.undo(names, shown.record);
    setTicked(tick.ticked);
    void changes.run(shown.record, action, names);
  };
  const sharedAbout = kinTasksSharedAbout(
    items.flatMap((item) => (item.type === "task" ? [item.record] : [])),
  );
  const grouped = kinTaskGroupedChip(within === undefined ? filter.groupBy : undefined);
  const nothing = kinWorkNothing(filter, names, scope);
  const footer = kinWorkListFooter(
    filter,
    records.length,
    listState.total,
    listState.more,
    hostEdits,
  );
  const add = canAdd
    ? () =>
        navigation.navigate("KinWorkNew", {
          environmentId,
          orgId,
          ...(filter.party === null
            ? {}
            : { party: filter.party.key, partyName: filter.party.title }),
          ...(filter.project === null
            ? {}
            : { project: filter.project.key, projectName: filter.project.title }),
        })
    : null;
  // The whole company's tasks also find clients, projects and docs, and say what needs you.
  const everywhere = within === undefined;
  const { state: found, search } = useKinSearch(props, ELSEWHERE, true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native search box comes back empty once the page was left (a result opened, another tab), so the words it narrowed by go with it
  useEffect(() => {
    const clear = () => {
      const held = list.getState().filter;
      if (held.text !== "") list.setFilter({ ...held, text: "" });
      search.setText("");
    };
    if (resumed) clear();
    return navigation.addListener("focus", clear);
  }, [list, navigation, resumed, search]);
  const steps = useKinTaskSteps({ environmentId, orgId });
  const base = { environmentId: String(environmentId), orgId: String(orgId) };
  const filterMenu = kinWorkFilterMenu({
    overview,
    filter,
    me: names.me,
    everyone: within === undefined,
    groups: within === undefined,
    choices: within === undefined ? props.choices : null,
    records,
    onChange: (next) => list.setFilter(next),
  });
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        actions={[
          // Inside a project, the project's own bar asks about the project instead.
          ...(agent === null || within !== undefined
            ? []
            : [
                {
                  accessibilityLabel: `Ask ${agent.name}`,
                  icon: "bubble.left" as const,
                  onPress: () => agent.ask(kinWorkAskDraft("tasks", narrowed)),
                },
              ]),
          ...(add === null
            ? []
            : [{ accessibilityLabel: KIN_WORK_NEW, icon: "plus" as const, onPress: add }]),
          ...(within?.bar.actions ?? []),
        ]}
        menus={[filterMenu, ...(within?.bar.menus ?? [])]}
        {...kinTabBar(tab, {
          onBack: props.onBack ?? (() => navigation.goBack()),
          search: {
            value: filter.text,
            onChangeText: (text) => {
              list.setFilter({ ...filter, text });
              if (everywhere) search.setText(text);
            },
            placeholder: KIN_WORK_SEARCH_PLACEHOLDER,
            closeAccessibilityLabel: "Close search",
            clearAccessibilityLabel: "Clear search",
          },
        })}
      />
      <ScreenContent surface="screen">
        {/* Hundreds of tasks stay cheap: only the rows in view mount. */}
        <LegendList<KinTasksItem<KinRecord>>
          renderScrollComponent={NativeScrollView}
          getItemType={(item) => item.type}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field, or the dock, floats over the foot of the list.
          contentContainerStyle={{
            paddingBottom: tab === null ? 96 : kinTabFoot(tab.bottomClearance),
          }}
          data={items}
          keyExtractor={(item) => item.key}
          extraData={[listState, changed, found, steps.status, needsYou, answers.busy]}
          estimatedItemSize={76}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pt-2">
              {within?.header}
              {shown === "rows" && (props.stale || listState.stale) ? (
                <View className="px-4">
                  <KinWorkStaleNotice
                    environmentId={environmentId}
                    onRetry={refresh}
                    readAt={listState.readAt}
                  />
                </View>
              ) : null}
              {narrowed === null && grouped === null ? null : (
                <View className="flex-row flex-wrap gap-2 px-4">
                  {grouped === null ? null : (
                    <Chip
                      label={grouped}
                      selected
                      trailingIcon="xmark"
                      accessibilityLabel={`${grouped}. ${KIN_WORK_HOME.clearFilter}`}
                      onPress={() => list.setFilter({ ...filter, groupBy: "me" })}
                    />
                  )}
                  {narrowed === null ? null : (
                    <Chip
                      label={narrowed}
                      selected
                      trailingIcon="xmark"
                      accessibilityLabel={`Showing ${narrowed}. ${KIN_WORK_HOME.clearFilter}`}
                      onPress={() =>
                        list.setFilter({
                          ...kinWorkFilterCleared(filter),
                          // A project's own list stays its project's.
                          ...(within === undefined
                            ? {}
                            : { party: filter.party, project: filter.project }),
                        })
                      }
                    />
                  )}
                </View>
              )}
              {notice === null || notice.undo !== null ? null : (
                <View className="px-4">
                  <Notice
                    message={`${notice.key}: ${notice.text}`}
                    tone={notice.kind === "failed" ? "danger" : "default"}
                    onDismiss={changes.dismiss}
                  />
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            records.length > 0 || items.length > 0 ? null : (
              <View className="px-4 pt-4">
                {shown === "offline" ? (
                  <EmptyState variant="plain" {...kinWorkOffline("tasks")} />
                ) : shown === "loading" ? (
                  <View
                    className="items-center py-12"
                    accessible
                    accessibilityRole="progressbar"
                    accessibilityLabel="Loading tasks"
                  >
                    <AppActivityIndicator />
                  </View>
                ) : shown === "failed" ? (
                  <KinLoadFailed
                    title={KIN_WORK_LOAD_FAILED}
                    cause={listState.failed}
                    onRetry={list.refresh}
                  />
                ) : searching && (found.hits?.length ?? 0) > 0 ? null : (
                  <EmptyState
                    variant="plain"
                    title={nothing.title}
                    detail={nothing.detail}
                    {...(nothing.offerNew && add !== null
                      ? { action: <Button tone="primary" label={KIN_WORK_NEW} onPress={add} /> }
                      : {})}
                  />
                )}
              </View>
            )
          }
          ListFooterComponent={
            <>
              {footer === null ? null : (
                <View className="items-start gap-2 px-5 py-4">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {listState.moreFailed ? KIN_MORE_FAILED : footer}
                  </Text>
                  <Button
                    tone="secondary"
                    size="compact"
                    label={listState.moreFailed ? KIN_RETRY : "Show more"}
                    loading={listState.loadingMore}
                    disabled={listState.loadingMore}
                    onPress={() => void list.loadMore()}
                  />
                </View>
              )}
              {searching ? (
                <View className="gap-2 pt-4">
                  <View className="px-4">
                    <ListSection title={KIN_WORK_HOME.elsewhere}>
                      <KinWorkToggleRow
                        label={KIN_SEARCH.includeClosed}
                        value={found.closed}
                        onValueChange={search.setClosed}
                      />
                    </ListSection>
                  </View>
                  <KinSearchHits
                    // A task found, or the list's own "Nothing matches", answers already.
                    quietWhenNone
                    state={found}
                    scope={scope}
                    onRetry={search.retry}
                    onOpen={openHit}
                  />
                </View>
              ) : null}
            </>
          }
          renderItem={({ item }) => {
            switch (item.type) {
              case "heading":
                return (
                  <KinTasksHeading
                    item={item}
                    onOpenProject={(project) =>
                      navigation.navigate("KinProject", { ...base, project: project.key })
                    }
                  />
                );
              case "clear":
                return <KinTasksAllClear />;
              case "done":
                return (
                  <KinTasksDoneRow
                    count={item.count}
                    onPress={() => list.setFilter({ ...filter, view: "closed" })}
                  />
                );
              case "foot":
                return (
                  <Text textRole="footnote" className="px-5 pt-2.5 text-foreground-muted">
                    {item.text}
                  </Text>
                );
              case "fact":
                return (
                  <View
                    className="mx-4 overflow-hidden border-continuous bg-grouped-card"
                    style={kinCardCorners(item.first, item.last)}
                  >
                    {item.first ? null : <View className="ml-12 h-px bg-border-subtle" />}
                    <KinAttentionItem
                      environmentId={environmentId}
                      orgId={orgId}
                      row={item.row}
                      names={names}
                      handler={answers}
                      onOpen={(to) =>
                        to.type === "record"
                          ? openRecord("KinWorkItem", { ...base, task: to.key })
                          : undefined
                      }
                    />
                    {answers.problem === null || !item.first ? null : (
                      <Text className="px-4 py-2 text-sm text-danger-foreground">
                        {answers.problem}
                      </Text>
                    )}
                  </View>
                );
              case "task": {
                const { record } = item;
                const step = kinTaskStep(record, item.move, names);
                const shown =
                  step?.kind === "nudge" && steps.nudged.has(record.key)
                    ? { ...step, nudged: true }
                    : step;
                return (
                  <KinTaskRow
                    row={kinWorkRow(
                      record,
                      names,
                      now,
                      item.inProject ? { ...filter, project: record.project ?? null } : filter,
                    )}
                    line={kinTaskLine(record, names, now, {
                      inProject: item.inProject,
                      quietNoDate:
                        (step !== null && step.kind !== "told") || item.move?.under === "noDate",
                      ownList: within === undefined,
                      sharedAbout,
                    })}
                    avatar={kinWorkAvatar(record.owner)}
                    step={shown}
                    status={kinTaskStepStatusShown(steps.status[record.key], shown)}
                    first={item.first}
                    last={item.last}
                    ticked={item.ticked === true}
                    saving={changed.pending[item.key] !== undefined}
                    onPress={() => openRecord("KinWorkItem", { ...base, task: item.key })}
                    onAct={canChange ? (action) => act(item.key, action) : null}
                    onChoose={
                      canAnswer && shown !== null && shown.kind !== "nudge" && shown.kind !== "told"
                        ? (optionId) => steps.choose(record.key, shown, optionId)
                        : null
                    }
                    onOpenCard={() =>
                      shown !== null && shown.kind !== "nudge" && shown.kind !== "told"
                        ? navigation.navigate("KinChat", {
                            ...base,
                            chatId: shown.card.chatId,
                            message: shown.card.messageId,
                          })
                        : undefined
                    }
                    onNudge={() => (canNudge ? steps.nudge(record.key) : undefined)}
                    onGive={() =>
                      navigation.navigate("KinWorkAssign", { ...base, task: record.key })
                    }
                  />
                );
              }
            }
          }}
        />
      </ScreenContent>
      {left === null || (notice !== null && notice.undo !== null) ? null : (
        <KinTasksUndoToast
          key={`left:${left.record.key}`}
          text={left.text}
          bottom={(tab?.bottomClearance ?? 0) + 12}
          onUndo={() => {
            forgetLeft();
            void changes.run(left.record, left.undo, names);
          }}
          onDismiss={forgetLeft}
        />
      )}
      {notice === null || notice.undo === null ? null : (
        <KinTasksUndoToast
          key={`${notice.key}:${notice.text}`}
          text={notice.text}
          bottom={(tab?.bottomClearance ?? 0) + 12}
          onUndo={() =>
            void changes.undo(
              names,
              records.find((held) => held.key === notice.key),
            )
          }
          onDismiss={changes.dismiss}
        />
      )}
    </View>
  );
}

/** A group's heading: its name and the host's count; a project's opens the project. */
function KinTasksHeading(props: {
  readonly item: Extract<KinTasksItem<KinRecord>, { readonly type: "heading" }>;
  readonly onOpenProject: (project: { readonly key: string; readonly title: string }) => void;
}) {
  const { item } = props;
  const { project } = item;
  const grows = useKinTextGrows();
  const body = (
    <View className={cn("min-w-0 flex-row items-baseline gap-1.5", !grows && "flex-1")}>
      <Text
        textRole="headline"
        numberOfLines={kinLines(1, grows)}
        className="shrink text-foreground"
      >
        {item.title}
      </Text>
      {item.count === null ? null : (
        <Text textRole="body" className="text-foreground-muted">
          {item.count}
        </Text>
      )}
      {project === null ? null : (
        <SymbolView
          name="chevron.right"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      )}
    </View>
  );
  const aside =
    item.aside === null ? null : (
      <Text
        textRole="footnote"
        numberOfLines={kinLines(1, grows)}
        className={cn("text-foreground-muted", !grows && "shrink-0")}
      >
        {item.aside}
      </Text>
    );
  return project === null ? (
    <View className={cn("px-5 pt-5 pb-2", grows ? "gap-0.5" : "flex-row items-baseline gap-3")}>
      {body}
      {aside}
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[item.title, item.count, item.aside]
        .filter((part) => part !== null)
        .join(", ")}
      accessibilityHint="Opens the project"
      onPress={() => props.onOpenProject(project)}
      className={cn(
        "px-5 pt-5 pb-2 active:opacity-60",
        grows ? "gap-0.5" : "flex-row items-baseline gap-3",
      )}
    >
      {body}
      {aside}
    </Pressable>
  );
}

/** Done in the last 14 days, as one row that shows them. */
function KinTasksDoneRow(props: { readonly count: number; readonly onPress: () => void }) {
  return (
    <View className="px-4 pt-5">
      <ListSection>
        <NavigationRow
          title={KIN_TASKS.done}
          leading={
            <SymbolView
              name="checkmark.circle"
              size={20}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          }
          trailing={
            <View className="flex-row items-center gap-1.5">
              <Text textRole="body" className="text-foreground-muted">
                {props.count}
              </Text>
              <SymbolView
                name="chevron.right"
                size={13}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </View>
          }
          onPress={props.onPress}
        />
      </ListSection>
    </View>
  );
}

/** Marked done or reopened from a row: the way back, for eight seconds, over the dock. */
function KinTasksUndoToast(props: {
  readonly text: string;
  readonly bottom: number;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}) {
  const { onDismiss } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the Undo stays eight seconds, then the change only lives in the task's Activity
  useEffect(() => {
    const timer = setTimeout(onDismiss, UNDO_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);
  return (
    <View
      collapsable={false}
      className="absolute right-4 left-4 z-[100]"
      style={{ bottom: props.bottom }}
      pointerEvents="box-none"
    >
      <Toast
        singleLine
        opaque
        message={props.text}
        action={{ label: KIN_WORK_COPY.undo, onPress: props.onUndo }}
        dismissMode="swipe"
        onDismiss={onDismiss}
      />
    </View>
  );
}

const UNDO_MS = 8_000;

/** Stable, so the toast's eight seconds don't start again on every render. */
const forgetLeft = () => appAtomRegistry.set(kinTaskLeftAtom, null);

/**
 * Tasks' one filter: five at a glance (`kinTaskQuickFilters`), then More filters with the other
 * views, client, project, who has it and how it groups.
 */
function kinWorkFilterMenu(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  readonly me: KinWorkNames["me"];
  /** Whether who has what is offered, which a project's own list leaves out. */
  readonly everyone: boolean;
  /** Whether Group by is offered, which a project's own list leaves out. */
  readonly groups: boolean;
  readonly choices: KinWorkChoices | null;
  /** The rows in view, whose projects the Filter offers too. */
  readonly records: ReadonlyArray<KinRecord>;
  readonly onChange: (filter: KinWorkFilter) => void;
}) {
  const { overview, filter, choices, onChange } = props;
  const pickMenu = (
    id: string,
    title: string,
    all: string,
    held: KinWorkRef | null,
    refs: ReadonlyArray<KinWorkRef>,
    pick: (ref: KinWorkRef | null) => KinWorkFilter,
  ): ReadonlyArray<AppBarMenuItem> =>
    refs.length === 0 && held === null
      ? []
      : [
          {
            id,
            title,
            items: [
              {
                id: `${id}:all`,
                title: all,
                selected: held === null,
                onPress: () => onChange(pick(null)),
              },
              ...refs.map((ref) => ({
                id: `${id}:${ref.key}`,
                title: ref.title,
                selected: ref.key === held?.key,
                onPress: () => onChange(pick(ref)),
              })),
            ],
          },
        ];
  const groupBy = filter.groupBy ?? "me";
  return {
    title: KIN_WORK_HOME.filter,
    icon: "line.3.horizontal.decrease.circle" as const,
    items: [
      {
        id: "quick",
        inline: true,
        items: kinTaskQuickFilters(filter, overview, props.me).map((one) => ({
          id: `quick:${one.id}`,
          title: one.label,
          ...(one.count === null ? {} : { subtitle: String(one.count) }),
          selected: one.selected,
          onPress: () => onChange(one.next),
        })),
      },
      {
        id: "more",
        title: KIN_TASK_FILTER.more,
        items: [
          {
            id: "view",
            title: KIN_WORK_HOME.show,
            inline: true,
            items: overview.chips
              .filter((chip) => KIN_TASK_MORE_VIEWS.includes(chip.id))
              .map((chip) => ({
                id: `view:${chip.id}`,
                title: chip.label,
                ...(chip.count === null ? {} : { subtitle: String(chip.count) }),
                selected: chip.selected,
                onPress: () => onChange({ ...filter, view: chip.selected ? "open" : chip.id }),
              })),
          },
          ...(choices === null
            ? []
            : [
                ...pickMenu(
                  "client",
                  KIN_WORK_HOME.byClient,
                  KIN_WORK_HOME.allClients,
                  filter.party,
                  choices.clients,
                  (party) => ({ ...filter, party }),
                ),
                ...pickMenu(
                  "project",
                  KIN_WORK_HOME.byProject,
                  KIN_WORK_HOME.allProjects,
                  filter.project,
                  kinTaskFilterProjects(choices.projects, props.records),
                  (project) => ({ ...filter, project }),
                ),
              ]),
          ...(!props.everyone || overview.owners.length === 0
            ? []
            : [
                {
                  id: "owner",
                  title: KIN_WORK_HOME.owner,
                  items: [
                    {
                      id: "owner:all",
                      title: KIN_WORK_HOME.everyone,
                      selected: filter.owner === null,
                      onPress: () => onChange({ ...filter, owner: null }),
                    },
                    ...overview.owners.map((owner) => ({
                      id: `owner:${owner.key}`,
                      title: owner.name,
                      subtitle: owner.line,
                      selected: kinWorkOwnerSelected(filter, owner.owner),
                      onPress: () => onChange({ ...filter, owner: owner.owner }),
                    })),
                  ],
                },
              ]),
          ...(!props.groups
            ? []
            : [
                {
                  id: "group",
                  title: KIN_TASKS.groupBy,
                  items: [
                    ...KIN_TASK_GROUP_BY.map((one) => ({
                      id: `group:${one.id}`,
                      title: one.label,
                      selected: one.id === groupBy,
                      onPress: () => onChange({ ...filter, groupBy: one.id }),
                    })),
                    // Said once, here: the order never changes.
                    {
                      id: "group:order",
                      title: KIN_TASKS.order,
                      disabled: true,
                      onPress: () => {},
                    },
                  ],
                },
              ]),
        ],
      },
    ],
  };
}
