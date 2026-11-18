import { useKinViewerScope } from "./state/kinChatOnly";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_CANVAS } from "@t3tools/client-runtime/kin/kinCanvasView";
import { KIN_SEARCH } from "@t3tools/client-runtime/kin/kinDocs";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  kinWorkOffline,
  kinWorkOnlyOwner,
  KIN_WORK_SEARCH_PLACEHOLDER,
  KIN_WORK_TITLE,
  kinWorkEntrySummary,
  kinWorkHostEdits,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOverview,
  kinWorkRow,
  kinWorkRowMarked,
  kinWorkShown,
  KIN_WORK_DEFAULT_FILTER,
  kinWorkHostClients,
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
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import { KIN_CLIENTS_OLDER_HOST } from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_HOME,
  kinClientsLine,
  kinDocsLine,
  kinMoneyLine,
  kinWorkAskDraft,
  kinWorkFilterCleared,
  kinWorkFilterLabel,
  kinWorkOwnerSelected,
  kinWorkPlaceParam,
  type KinWorkPlace,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import {
  KIN_WORK_LIST_INITIAL,
  createKinListKeeper,
  createKinWorkList,
  type KinWorkList,
  type KinWorkListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import {
  kinWorkGroupWithin,
  kinTasksTop,
  kinWorkGroupsShown,
  type KinWorkGroupItem,
} from "@t3tools/client-runtime/kin/kinWorkGroups";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinRecord } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinDocsList, KinSearchHits } from "./KinDocsList";
import { KinTasksAttention, useKinNeedsRows } from "./KinNeedsYou";
import { connectionAtomRuntime } from "../../connection/runtime";
import { KinAvatar } from "./components/KinAvatar";
import { KinHandOverRow } from "./components/KinAway";
import { KinClientsList } from "./KinWorkLists";
import { KinMoneyArea } from "./KinWorkMoney";
import { KinListBanner } from "./components/KinListBanner";
import { kinTabBar, useKinTab } from "./components/KinTab";
import { KinWorkStaleNotice, KinWorkTaskRow } from "./components/KinWorkPieces";
import { kinClient, retryKinAccess } from "./state/kinClient";
import { useKinOpenPlace } from "./state/kinHomeTab";
import { useKinOpenHit, useKinWorkLink } from "./state/kinWorkLink";
import { useKinSearch } from "./state/useKinDocs";
import { useKinAskAgent, useKinMoneySummary } from "./state/useKinMoney";
import {
  kinWorkLiveAtom,
  refreshKinWorkLive,
  useKinWork,
  useKinWorkChanges,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { useKinClientCounts, useKinDocsRecent } from "./state/useKinWorkHome";
import { KinLoadFailed } from "./components/KinLoadFailed";

/** Task lists kept while their screen is away, so coming back reads nothing the stream brought. */
const kinTaskLists = createKinListKeeper<KinWorkList, KinWorkListState>(Date.now);

/** What the Tasks search finds besides tasks, which the list itself already narrows to. */
const ELSEWHERE = ["clients", "contacts", "projects", "docs"] as const;

export type KinWorkParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The place that opens: `tasks`, `clients`, `projects`, `docs` or `money`; Tasks otherwise. */
  readonly show?: string;
  /** The client the tasks start narrowed to, or a new task starts under. */
  readonly party?: string;
  readonly partyName?: string;
  readonly project?: string;
  readonly projectName?: string;
  /** `theirs` when a new task is something the client owes. */
  readonly side?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** A client or project named in a link: its handle, and the name to show until it is read. */
export function kinWorkRefParam(key: string | undefined, title: string | undefined) {
  const held = Option.getOrNull(decodeKey(key));
  return held === null ? null : { key: held, title: title ?? held };
}

/**
 * The ways in from the chat list over coding threads, where there is no dock: one row per place,
 * each saying what is in it. A place the host keeps from this viewer has no row.
 */
export function KinWorkEntry(target: KinWorkTarget) {
  const state = useKinWork(target);
  // A teammate, or a host that couldn't be read: no way in rather than a dead one.
  if (state._tag === "refused" || state._tag === "failed") return null;
  return <KinPlaceEntries {...target} live={state._tag === "ready" ? state.live : null} />;
}

function KinPlaceEntries(props: KinWorkTarget & { readonly live: KinWorkLive | null }) {
  const navigation = useNavigation();
  const open = useKinOpenPlace(props);
  const summary = props.live?.summary ?? null;
  const hostClients = kinWorkHostClients(summary);
  const money = useKinMoneySummary(props, { enabled: true }).state;
  const docs = useKinDocsRecent(props);
  const counts = useKinClientCounts(props, hostClients);
  const scope = useKinViewerScope(props.environmentId);
  return (
    <>
      <KinWorkEntryRow summary={kinWorkEntrySummary(summary)} onPress={() => open("tasks")} />
      <KinListBanner
        title={KIN_CANVAS.title}
        summary={KIN_CANVAS.entrySummary}
        symbol="square.grid.2x2"
        accessibilityLabel={`${KIN_CANVAS.title}. ${KIN_CANVAS.entrySummary}`}
        accessibilityHint={`Opens ${KIN_CANVAS.title}`}
        onPress={() =>
          navigation.navigate("KinCanvas", {
            environmentId: String(props.environmentId),
            orgId: String(props.orgId),
          })
        }
      />
      <View className="ml-5 h-px bg-border-subtle" />
      {money._tag === "refused" || money._tag === "failed" ? null : (
        <KinPlaceEntryRow
          place="money"
          summary={money._tag === "ready" ? kinMoneyLine(money.value, scope) : null}
          onPress={() => open("money")}
        />
      )}
      {!hostClients ? null : (
        <KinPlaceEntryRow
          place="clients"
          summary={counts === null ? null : kinClientsLine(counts.clients, counts.projects)}
          onPress={() => open("clients")}
        />
      )}
      {docs.refused ? null : (
        <KinPlaceEntryRow
          place="docs"
          summary={docs.docs === null ? null : kinDocsLine(docs.docs.total, docs.docs.changed)}
          onPress={() => open("docs")}
        />
      )}
    </>
  );
}

export const KIN_PLACE_SYMBOL = {
  tasks: "checkmark.circle",
  money: "banknote",
  clients: "person.2",
  docs: "doc.text",
} as const satisfies Record<KinWorkPlace, AppSymbolName>;

function KinPlaceEntryRow(props: {
  readonly place: KinWorkPlace;
  readonly summary: string | null;
  readonly onPress: () => void;
}) {
  const title = KIN_WORK_HOME.places[props.place];
  const summary = props.summary ?? "…";
  return (
    <>
      <KinListBanner
        title={title}
        summary={summary}
        symbol={KIN_PLACE_SYMBOL[props.place]}
        accessibilityLabel={`${title}. ${summary}`}
        accessibilityHint={`Opens ${title}`}
        onPress={props.onPress}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinWorkEntryRow(props: { readonly summary: string; readonly onPress: () => void }) {
  return (
    <>
      <KinListBanner
        title={KIN_WORK_HOME.places.tasks}
        summary={props.summary}
        symbol={KIN_PLACE_SYMBOL.tasks}
        accessibilityLabel={`${KIN_WORK_HOME.places.tasks}. ${props.summary}`}
        accessibilityHint="Opens what is open and who has it"
        onPress={props.onPress}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** A place of Work as a page, from a link or over coding threads. */
export function KinWorkScreen({ route }: StaticScreenProps<KinWorkParams>) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <KinWorkMessage title={KIN_WORK_TITLE}>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open Work from your Kin chats."
        />
      </KinWorkMessage>
    );
  }
  return (
    <KinPlace
      environmentId={environmentId}
      orgId={orgId}
      place={kinWorkPlaceParam(route.params.show)}
      party={kinWorkRefParam(route.params.party, route.params.partyName)}
      project={kinWorkRefParam(route.params.project, route.params.projectName)}
    />
  );
}

/** Every state that isn't the list, inside the scroll view that clears the floating bar. */
function KinWorkMessage(props: { readonly title: string; readonly children: React.ReactNode }) {
  const navigation = useNavigation();
  const tab = useKinTab();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} {...(tab ? {} : { onBack: () => navigation.goBack() })} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            padding: 16,
            paddingBottom: 32 + (tab?.bottomClearance ?? 0),
            gap: 20,
          }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** One place of Work: a tab of the Kin home inside a `KinTabContext`, or a pushed page. */
export function KinPlace(
  props: KinWorkTarget & {
    readonly place: ReturnType<typeof kinWorkPlaceParam>;
    readonly party: KinWorkRef | null;
    readonly project: KinWorkRef | null;
  },
) {
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const state = useKinWork(target);
  const ready = state._tag === "ready";
  const hostClients = kinWorkHostClients(ready ? state.live.summary : null);
  const directory = useKinWorkDirectory(target, ready);
  const { place } = props;
  const choices = useKinWorkChoices(target, ready && hostClients && place.place === "tasks");
  const title = KIN_WORK_HOME.places[place.place];
  if (state._tag === "ready") {
    const shared = { ...target, live: state.live, stale: state.stale, directory };
    // An older server has tasks only, and a link to anything else says why.
    if (place.place !== "tasks" && !hostClients) {
      return (
        <KinWorkMessage title={title}>
          <EmptyState variant="plain" {...KIN_CLIENTS_OLDER_HOST} />
        </KinWorkMessage>
      );
    }
    if (place.place === "docs") return <KinDocsList {...shared} />;
    if (place.place === "clients") return <KinClientsList {...shared} projects={place.projects} />;
    if (place.place === "money") return <KinMoneyArea {...shared} />;
    return (
      <KinWorkTaskList
        {...shared}
        title={title}
        choices={hostClients ? choices : null}
        initial={{ ...KIN_WORK_DEFAULT_FILTER, party: props.party, project: props.project }}
      />
    );
  }
  return (
    <KinWorkMessage title={title}>
      {state._tag === "refused" ? (
        <EmptyState variant="plain" {...kinWorkOnlyOwner(place.place)} />
      ) : state._tag === "offline" ? (
        <EmptyState variant="plain" {...kinWorkOffline(place.place)} />
      ) : state._tag === "failed" ? (
        <KinLoadFailed
          title={KIN_WORK_LOAD_FAILED}
          cause={null}
          onRetry={() => {
            retryKinAccess(target.environmentId);
            appAtomRegistry.refresh(kinWorkLiveAtom(target));
          }}
        />
      ) : (
        <View
          className="items-center py-12"
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`Loading ${title}`}
        >
          <AppActivityIndicator />
        </View>
      )}
    </KinWorkMessage>
  );
}

/** Tasks, a screenful at a time: all of them, or the ones under one project. */
export function KinWorkTaskList(
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
  const { state: changed, changes } = useKinWorkChanges(props);
  const agent = useKinAskAgent(props, "tasks");
  const hostEdits = kinWorkHostEdits(live.summary);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)) && hostEdits;
  const now = new Date(useNowMinuteMs());
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
    if (resumed) list.resume();
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
  const scope = useKinViewerScope(environmentId);
  const overview = kinWorkOverview(live.summary, filter, names);
  const records = kinWorkShown(filter, listState.records, hostEdits).map((record) =>
    kinWorkApplied(record, changed),
  );
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = records.find((held) => held.key === key);
    if (record !== undefined) void changes.run(record, action, names);
  };
  const notice = kinWorkListNotice(changed, null);
  const me = names.me;
  const mineOpen =
    props.within === undefined && me !== null
      ? (overview.owners.find((row) => row.owner._tag === "person" && row.owner.personId === me)
          ?.open ?? 0)
      : 0;
  // A project's own list is always its project's, so only the rest of the filter is a chip.
  const narrowed = kinWorkFilterLabel(
    props.within === undefined ? filter : { ...filter, party: null, project: null },
    names,
  );
  const ownerLevel = useAtomValue(kinOwnerLevelAtom(connectionAtomRuntime, environmentId));
  const grouped = props.within === undefined && kinWorkGroupsShown(filter, names.me);
  // The whole company's open tasks, unsearched: the owner's block leads, over "On me".
  const showsBlock = grouped && narrowed === null;
  const needs = useKinNeedsRows({ ...props, names }, showsBlock && ownerLevel);
  const top = kinTasksTop({
    ownerLevel: needs !== null,
    records,
    names,
    now,
    attention: needs?.attention ?? [],
    needs: needs?.needs ?? [],
    hidden: needs?.hidden ?? 0,
    handled: needs?.handled.length ?? 0,
    expanded: needs?.expanded ?? false,
  });
  // The plain list reads by whom each task waits on; a filtered one stays one list.
  const items: ReadonlyArray<KinWorkGroupItem<KinRecord>> = grouped
    ? top.items
    : records.map((record) => ({ type: "task", key: record.key, record, section: null }));
  const rows: ReadonlyArray<KinWorkListItem> = items.map((item) =>
    item.type === "task"
      ? {
          ...item,
          row: kinWorkRowMarked(
            kinWorkRow(item.record, names, now, kinWorkGroupWithin(item, filter)),
            item.mark ?? null,
          ),
        }
      : item,
  );
  const nothing = kinWorkNothing(filter, names, scope);
  // Needs attention shows some, so the count says how many are loaded in all.
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
  const { within } = props;
  // The whole company's tasks also find clients, projects and docs, and say what needs you.
  const everywhere = within === undefined;
  const { state: found, search } = useKinSearch(props, ELSEWHERE);
  const searching = everywhere && filter.text.trim() !== "";
  const filterMenu = kinWorkFilterMenu({
    overview,
    filter,
    everyone: within === undefined,
    choices: within === undefined ? props.choices : null,
    onChange: (next) => list.setFilter(next),
  });
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        actions={[
          ...(agent === null
            ? []
            : [
                {
                  accessibilityLabel: `Ask ${agent.name}`,
                  icon: "bubble.left" as const,
                  onPress: () =>
                    agent.ask(
                      kinWorkAskDraft("tasks", within === undefined ? narrowed : props.title),
                    ),
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
        <LegendList<KinWorkListItem>
          renderScrollComponent={NativeScrollView}
          getItemType={(item) => item.type}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field, or the dock, floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: tab === null ? 96 : 32 + tab.bottomClearance }}
          data={rows}
          keyExtractor={(row) => row.key}
          extraData={[listState, changed, found]}
          estimatedItemSize={68}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pt-2">
              {within?.header}
              {needs === null || top.block === null ? null : (
                <KinTasksAttention
                  environmentId={environmentId}
                  orgId={orgId}
                  {...needs}
                  {...top.block}
                  handled={needs.handled}
                />
              )}
              {props.stale || listState.stale ? (
                <View className="px-4">
                  <KinWorkStaleNotice environmentId={environmentId} onRetry={refresh} />
                </View>
              ) : null}
              {narrowed === null ? null : (
                <View className="flex-row px-4">
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
                </View>
              )}
              {notice === null ? null : (
                <View className="px-4">
                  <Notice
                    message={`${notice.key}: ${notice.text}`}
                    tone={notice.kind === "failed" ? "danger" : "default"}
                    {...(notice.undo === null
                      ? { onDismiss: changes.dismiss }
                      : {
                          action: {
                            label: KIN_WORK_COPY.undo,
                            onPress: () =>
                              void changes.undo(
                                names,
                                records.find((held) => held.key === notice.key),
                              ),
                          },
                        })}
                  />
                </View>
              )}
              {me === null || mineOpen === 0 ? null : (
                <View className="px-4">
                  <ListSection>
                    <KinHandOverRow
                      environmentId={environmentId}
                      orgId={orgId}
                      from={{ _tag: "person", personId: me }}
                      fromName={null}
                      onDone={refresh}
                    />
                  </ListSection>
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            // Every open task is already under Needs attention.
            records.length > 0 ? null : (
              <View className="px-4 pt-4">
                {listState.loading ? (
                  <View
                    className="items-center py-12"
                    accessible
                    accessibilityRole="progressbar"
                    accessibilityLabel="Loading tasks"
                  >
                    <AppActivityIndicator />
                  </View>
                ) : listState.failed !== null ? (
                  <KinLoadFailed
                    title={KIN_WORK_LOAD_FAILED}
                    cause={listState.failed}
                    onRetry={list.refresh}
                  />
                ) : (
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
                    {listState.moreFailed ? "Couldn't load more." : footer}
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
                      <ListToggleRow
                        label={KIN_SEARCH.includeClosed}
                        value={found.closed}
                        onValueChange={search.setClosed}
                      />
                    </ListSection>
                  </View>
                  <KinSearchHits
                    state={found}
                    scope={scope}
                    onRetry={search.retry}
                    onOpen={openHit}
                  />
                </View>
              ) : null}
            </>
          }
          renderItem={({ item }) =>
            item.type === "section" ? (
              <View className="flex-row items-baseline gap-2 px-5 pt-5 pb-1">
                <Text textRole="headline" numberOfLines={1} className="shrink text-foreground">
                  {item.title}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {item.count}
                </Text>
              </View>
            ) : item.type === "who" ? (
              <View className="flex-row items-center gap-2 px-5 pt-2 pb-0.5">
                <KinAvatar avatar={item.avatar} size="mini" />
                <Text
                  textRole="footnote"
                  numberOfLines={1}
                  className="shrink text-foreground-muted"
                >
                  {item.name}
                </Text>
              </View>
            ) : (
              <KinWorkTaskRow
                row={item.row}
                saving={changed.pending[item.key] !== undefined}
                onPress={() => openRecord("KinWorkItem", { environmentId, orgId, task: item.key })}
                onAct={canChange ? (action) => act(item.key, action) : null}
              />
            )
          }
        />
      </ScreenContent>
    </View>
  );
}

/** A line of the list: a part's heading, whom a run waits on, or a task with its row. */
type KinWorkListItem =
  | Exclude<KinWorkGroupItem<KinRecord>, { readonly type: "task" }>
  | (Extract<KinWorkGroupItem<KinRecord>, { readonly type: "task" }> & {
      readonly row: KinWorkRowView;
    });

/** Tasks' one filter: what state, whose client or project, and who has it. */
function kinWorkFilterMenu(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  /** Whether who has what is offered, which a project's own list leaves out. */
  readonly everyone: boolean;
  readonly choices: KinWorkChoices | null;
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
  return {
    title: KIN_WORK_HOME.filter,
    icon: "line.3.horizontal.decrease.circle" as const,
    items: [
      {
        id: "view",
        title: KIN_WORK_HOME.show,
        inline: true,
        items: overview.chips.map((chip) => ({
          id: `view:${chip.id}`,
          title: chip.label,
          ...(chip.count === null ? {} : { subtitle: String(chip.count) }),
          selected: chip.selected,
          onPress: () => onChange({ ...filter, view: chip.id }),
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
              choices.projects,
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
    ],
  };
}
