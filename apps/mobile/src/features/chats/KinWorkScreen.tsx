import { kinTabBar, useKinTab } from "./components/KinTab";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_OFFLINE,
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_SEARCH_PLACEHOLDER,
  KIN_WORK_TITLE,
  kinWorkEntrySummary,
  kinWorkHostEdits,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOverview,
  kinWorkRow,
  kinWorkShown,
  KIN_WORK_DEFAULT_FILTER,
  kinWorkHostClients,
  type KinWorkFilter,
  type KinWorkOverview,
  type KinWorkRef,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import { KIN_SEARCH } from "@t3tools/client-runtime/kin/kinDocs";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  kinWorkListNotice,
  type KinWorkAction,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_CLIENTS,
  KIN_CLIENTS_OLDER_HOST,
  KIN_PROJECTS,
  type KinWorkArea,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_LIST_INITIAL,
  createKinWorkList,
  type KinWorkListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { EnvironmentId, KinOrgId, KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinListBanner } from "./components/KinListBanner";
import {
  KinWorkAreaSwitch,
  KinWorkStaleNotice,
  KinWorkTaskRow,
  type KinWorkAreas,
} from "./components/KinWorkPieces";
import { KinDocsList } from "./KinDocsList";
import { KinClientsList, KinProjectsList } from "./KinWorkLists";
import { kinClient } from "./state/kinClient";
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

export type KinWorkParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** Which part of Work opens: `clients`, `projects` or `docs`; tasks otherwise. */
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

/** The way in from the chat list, for the owner only. Its second line says what needs a look. */
export function KinWorkEntry(target: KinWorkTarget) {
  const navigation = useNavigation();
  const state = useKinWork(target);
  // A teammate, or a host that couldn't be read: no way in rather than a dead one.
  if (state._tag === "refused" || state._tag === "failed") return null;
  return (
    <KinWorkEntryRow
      summary={kinWorkEntrySummary(state._tag === "ready" ? state.live.summary : null)}
      onPress={() => navigation.navigate("KinWork", target)}
    />
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinWorkEntryRow(props: { readonly summary: string; readonly onPress: () => void }) {
  return (
    <>
      <KinListBanner
        title={KIN_WORK_TITLE}
        summary={props.summary}
        symbol="checkmark.circle"
        accessibilityLabel={`${KIN_WORK_TITLE}. ${props.summary}`}
        accessibilityHint="Opens what is open and who has it"
        onPress={props.onPress}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** Everything someone owes someone: what is open, who has it, and the way to hand it on. */
export function KinWorkScreen({ route }: StaticScreenProps<KinWorkParams>) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <KinWorkMessage>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open Work from your Kin chats."
        />
      </KinWorkMessage>
    );
  }
  const start =
    route.params.show === "clients" ||
    route.params.show === "projects" ||
    route.params.show === "docs"
      ? route.params.show
      : "tasks";
  return (
    <KinWorkStates
      environmentId={environmentId}
      orgId={orgId}
      start={start}
      party={kinWorkRefParam(route.params.party, route.params.partyName)}
      project={kinWorkRefParam(route.params.project, route.params.projectName)}
    />
  );
}

/** Every state that isn't the list, inside the scroll view that clears the floating bar. */
function KinWorkMessage(props: { readonly children: React.ReactNode }) {
  const navigation = useNavigation();
  const tab = useKinTab();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_WORK_TITLE} {...(tab ? {} : { onBack: () => navigation.goBack() })} />
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

/** Work as a tab of the Kin home, inside a `KinTabContext`: the same lists, with no way back. */
export function KinWorkTab(props: KinWorkTarget) {
  return <KinWorkStates {...props} start="tasks" party={null} project={null} />;
}

function KinWorkStates(
  props: KinWorkTarget & {
    readonly start: KinWorkArea;
    readonly party: KinWorkRef | null;
    readonly project: KinWorkRef | null;
  },
) {
  const navigation = useNavigation();
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const state = useKinWork(target);
  const ready = state._tag === "ready";
  const hostClients = kinWorkHostClients(ready ? state.live.summary : null);
  const directory = useKinWorkDirectory(target, ready);
  const choices = useKinWorkChoices(target, ready && hostClients);
  const [area, setArea] = useState(props.start);
  const [words, setWords] = useState("");
  if (state._tag === "ready") {
    const shared = { ...target, live: state.live, stale: state.stale, directory };
    // An older server has tasks only: no switch, and a link to clients says why.
    const areas = hostClients ? { area, onArea: setArea, words, onWords: setWords } : null;
    if (area !== "tasks" && !hostClients) {
      return (
        <KinWorkMessage>
          <EmptyState
            variant="plain"
            {...KIN_CLIENTS_OLDER_HOST}
            action={<Button tone="secondary" label="Open tasks" onPress={() => setArea("tasks")} />}
          />
        </KinWorkMessage>
      );
    }
    const searchAll = () => navigation.navigate("KinSearch", target);
    if (area === "docs" && areas !== null)
      return (
        <KinDocsList
          {...target}
          directory={directory}
          stale={state.stale}
          areas={areas}
          onSearchAll={searchAll}
        />
      );
    if (area === "clients" && areas !== null) return <KinClientsList {...shared} areas={areas} />;
    if (area === "projects" && areas !== null) return <KinProjectsList {...shared} areas={areas} />;
    return (
      <KinWorkTaskList
        {...shared}
        title={KIN_WORK_TITLE}
        onBack={() => navigation.goBack()}
        areas={areas}
        choices={hostClients ? choices : null}
        initial={{
          ...KIN_WORK_DEFAULT_FILTER,
          party: props.party,
          project: props.project,
          text: areas?.words ?? "",
        }}
        onSearchAll={searchAll}
      />
    );
  }
  return (
    <KinWorkMessage>
      {state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      ) : state._tag === "offline" ? (
        <EmptyState variant="plain" {...KIN_WORK_OFFLINE} />
      ) : state._tag === "failed" ? (
        <EmptyState
          variant="plain"
          title={KIN_WORK_LOAD_FAILED}
          detail="Check your connection to the server and try again."
          action={
            <Button
              tone="secondary"
              label="Try again"
              onPress={() => appAtomRegistry.refresh(kinWorkLiveAtom(target))}
            />
          }
        />
      ) : (
        <View
          className="items-center py-12"
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Loading Work"
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
    readonly onBack: () => void;
    readonly areas: KinWorkAreas | null;
    /** What the list can be narrowed to; null on an older server, or inside a project. */
    readonly choices: KinWorkChoices | null;
    readonly initial: KinWorkFilter;
    /** Opens the search over everything in Work; absent inside a project. */
    readonly onSearchAll?: () => void;
    /** A project's page: its summary heads the list, which stays narrowed to it. */
    readonly within?: {
      readonly header: React.ReactNode;
      readonly bar: Pick<React.ComponentProps<typeof AppBar>, "actions" | "menus">;
    };
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, live } = props;
  const { names } = props.directory;
  const canAdd = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const { state: changed, changes } = useKinWorkChanges(props);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when the screen shows, and abandons what is in flight when it leaves
  useEffect(() => {
    list.start();
    return list.dispose;
  }, [list]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, and that the host is back, so it reads again only when the rows are behind
  useEffect(() => {
    if (!props.stale) list.changed(live.seq);
  }, [list, live.seq, props.stale]);

  const refresh = () => {
    refreshKinWorkLive({ environmentId, orgId });
    list.refresh();
  };
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
  const notice = kinWorkListNotice(changed, null);
  const nothing = kinWorkNothing(filter, names);
  const footer = kinWorkListFooter(filter, rows.length, listState.total, listState.more, hostEdits);
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
  // A project's own page is always a pushed page, even when it was opened from the Work tab.
  const tab = useKinTab();
  const docked = within === undefined ? tab : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        actions={[
          ...(props.onSearchAll === undefined
            ? []
            : [
                {
                  accessibilityLabel: KIN_SEARCH.hint.title,
                  icon: "magnifyingglass" as const,
                  onPress: props.onSearchAll,
                },
              ]),
          ...(add === null
            ? []
            : [{ accessibilityLabel: KIN_WORK_NEW, icon: "plus" as const, onPress: add }]),
          ...(within?.bar.actions ?? []),
        ]}
        {...(within?.bar.menus === undefined ? {} : { menus: within.bar.menus })}
        {...kinTabBar(docked, {
          onBack: props.onBack,
          search: {
            value: filter.text,
            onChangeText: (text) => {
              props.areas?.onWords(text);
              list.setFilter({ ...filter, text });
            },
            placeholder: KIN_WORK_SEARCH_PLACEHOLDER,
            closeAccessibilityLabel: "Close search",
            clearAccessibilityLabel: "Clear search",
          },
        })}
      />
      <ScreenContent surface="screen">
        {/* Hundreds of tasks stay cheap: only the rows in view mount. */}
        <LegendList<KinWorkRowView>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field, or the tab dock, floats over the foot of the list.
          contentContainerStyle={{
            paddingBottom: docked === null ? 96 : 24 + docked.bottomClearance,
          }}
          data={rows}
          keyExtractor={(row) => row.key}
          extraData={[listState, changed]}
          estimatedItemSize={68}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pb-1 pt-2">
              {props.areas === null ? null : <KinWorkAreaSwitch {...props.areas} />}
              {within?.header}
              {props.stale || listState.stale ? (
                <View className="px-4">
                  <KinWorkStaleNotice environmentId={environmentId} onRetry={refresh} />
                </View>
              ) : null}
              <KinWorkFilters
                overview={overview}
                filter={filter}
                everyone={within === undefined}
                choices={within === undefined ? props.choices : null}
                onChange={(next) => list.setFilter(next)}
              />
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
            </View>
          }
          ListEmptyComponent={
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
                <EmptyState
                  variant="plain"
                  title={KIN_WORK_LOAD_FAILED}
                  detail="Check your connection to the server and try again."
                  action={<Button tone="secondary" label="Try again" onPress={list.refresh} />}
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
          }
          ListFooterComponent={
            footer === null ? null : (
              <View className="items-start gap-2 px-5 py-4">
                <Text textRole="footnote" className="text-foreground-muted">
                  {listState.moreFailed ? "Couldn't load more." : footer}
                </Text>
                <Button
                  tone="secondary"
                  size="compact"
                  label={listState.moreFailed ? "Try again" : "Show more"}
                  loading={listState.loadingMore}
                  disabled={listState.loadingMore}
                  onPress={() => void list.loadMore()}
                />
              </View>
            )
          }
          renderItem={({ item: row }) => (
            <KinWorkTaskRow
              row={row}
              saving={changed.pending[row.key] !== undefined}
              onPress={() =>
                navigation.navigate("KinWorkItem", { environmentId, orgId, task: row.key })
              }
              onAct={canChange ? (action) => act(row.key, action) : null}
            />
          )}
        />
      </ScreenContent>
    </View>
  );
}

/** The overview and the filters in one: every count narrows the list to what it counts. */
function KinWorkFilters(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  /** Whether who has what is offered, which a project's own list leaves out. */
  readonly everyone: boolean;
  readonly choices: KinWorkChoices | null;
  readonly onChange: (filter: KinWorkFilter) => void;
}) {
  const { overview, filter, choices } = props;
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      >
        {overview.chips.map((chip) => (
          <Chip
            key={chip.id}
            label={chip.count === null ? chip.label : `${chip.label} ${chip.count}`}
            accessibilityLabel={chip.accessibilityLabel}
            selected={chip.selected}
            onPress={() => props.onChange({ ...filter, view: chip.id })}
          />
        ))}
      </ScrollView>
      {choices === null ||
      (choices.clients.length === 0 && choices.projects.length === 0) ? null : (
        <View className="flex-row flex-wrap gap-2 px-4">
          <ScopeChip
            all={KIN_CLIENTS.all}
            held={filter.party}
            choices={choices.clients}
            onPick={(party) => props.onChange({ ...filter, party })}
          />
          <ScopeChip
            all={KIN_PROJECTS.all}
            held={filter.project}
            choices={choices.projects}
            onPick={(project) => props.onChange({ ...filter, project })}
          />
        </View>
      )}
      {!props.everyone || overview.owners.length === 0 ? null : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          {overview.owners.map((owner) => (
            <Chip
              key={owner.key}
              size="small"
              label={`${owner.name} ${owner.open}`}
              accessibilityLabel={`${owner.name}. ${owner.line}`}
              selected={owner.selected}
              onPress={() =>
                props.onChange({ ...filter, owner: owner.selected ? null : owner.owner })
              }
            />
          ))}
        </ScrollView>
      )}
    </>
  );
}

const EVERY = "all";

/** Narrows the list to one client or one project, or back to all of them. */
function ScopeChip(props: {
  readonly all: string;
  readonly held: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  readonly onPick: (ref: KinWorkRef | null) => void;
}) {
  const { held } = props;
  if (props.choices.length === 0 && held === null) return null;
  const label = held?.title ?? props.all;
  return (
    <Menu
      title={props.all}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Change`}
      actions={[
        { id: EVERY, title: props.all, state: held === null ? "on" : "off" },
        ...props.choices.map((choice) => ({
          id: choice.key,
          title: choice.title,
          state: choice.key === held?.key ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent: { event } }) =>
        props.onPick(
          event === EVERY ? null : (props.choices.find((choice) => choice.key === event) ?? held),
        )
      }
    >
      <View pointerEvents="none">
        <Chip size="small" label={label} selected={held !== null} trailingIcon="chevron.down" />
      </View>
    </Menu>
  );
}
