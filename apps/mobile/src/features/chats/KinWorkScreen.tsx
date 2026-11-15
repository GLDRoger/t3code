import { useKinTab } from "./components/KinTab";
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
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  kinWorkListNotice,
  type KinWorkAction,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import { KIN_CLIENTS_OLDER_HOST } from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_HOME,
  kinWorkAskDraft,
  kinWorkFilterCleared,
  kinWorkFilterLabel,
  kinWorkOwnerSelected,
  kinWorkPlaceParam,
} from "@t3tools/client-runtime/kin/kinWorkHome";
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
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinListBanner } from "./components/KinListBanner";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { KinWorkStaleNotice, KinWorkTaskRow } from "./components/KinWorkPieces";
import { KinDocsList } from "./KinDocsList";
import { KinWorkHome } from "./KinWorkHome";
import { KinClientsList } from "./KinWorkLists";
import { KinListsArea, KinMoneyArea } from "./KinWorkMoney";
import { kinClient } from "./state/kinClient";
import { useKinAskAgent } from "./state/useKinMoney";
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
import { useKinWorkLink } from "./state/kinWorkLink";

export type KinWorkParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The place that opens: `tasks`, `clients`, `projects`, `docs`, `money` or `lists`; Work itself otherwise. */
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
  // Narrowed to a client or project, tasks open even on a link from before places.
  const place =
    kinWorkPlaceParam(route.params.show) ??
    (route.params.party === undefined && route.params.project === undefined
      ? null
      : { place: "tasks" as const, projects: false });
  return (
    <KinWorkStates
      environmentId={environmentId}
      orgId={orgId}
      place={place}
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

/** Work as a tab of the Kin home, inside a `KinTabContext`: the Work page, with no way back. */
export function KinWorkTab(props: KinWorkTarget) {
  return <KinWorkStates {...props} place={null} party={null} project={null} />;
}

function KinWorkStates(
  props: KinWorkTarget & {
    /** Null is the Work page itself; a place is pushed above it. */
    readonly place: ReturnType<typeof kinWorkPlaceParam>;
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
  const choices = useKinWorkChoices(target, ready && hostClients && props.place?.place === "tasks");
  const { place } = props;
  if (state._tag === "ready") {
    const shared = { ...target, live: state.live, stale: state.stale, directory };
    if (place === null) return <KinWorkHome {...shared} />;
    // An older server has tasks only, and a link to anything else says why.
    if (place.place !== "tasks" && !hostClients) {
      return (
        <KinWorkMessage>
          <EmptyState variant="plain" {...KIN_CLIENTS_OLDER_HOST} />
        </KinWorkMessage>
      );
    }
    if (place.place === "docs")
      return <KinDocsList {...target} directory={directory} stale={state.stale} />;
    if (place.place === "clients") return <KinClientsList {...shared} projects={place.projects} />;
    if (place.place === "money") return <KinMoneyArea {...shared} />;
    if (place.place === "lists") return <KinListsArea {...shared} />;
    return (
      <KinWorkTaskList
        {...shared}
        title={KIN_WORK_HOME.places.tasks}
        onBack={() => navigation.goBack()}
        choices={hostClients ? choices : null}
        initial={{ ...KIN_WORK_DEFAULT_FILTER, party: props.party, project: props.project }}
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
  const openRecord = useKinWorkLink();
  const { environmentId, orgId, live } = props;
  const { names } = props.directory;
  const canAdd = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const { state: changed, changes } = useKinWorkChanges(props);
  const agent = useKinAskAgent(props, "tasks");
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
  // A project's own list is always its project's, so only the rest of the filter is a chip.
  const narrowed = kinWorkFilterLabel(
    props.within === undefined ? filter : { ...filter, party: null, project: null },
    names,
  );
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
        onBack={props.onBack}
        search={{
          value: filter.text,
          onChangeText: (text) => list.setFilter({ ...filter, text }),
          placeholder: KIN_WORK_SEARCH_PLACEHOLDER,
          closeAccessibilityLabel: "Close search",
          clearAccessibilityLabel: "Clear search",
        }}
      />
      <ScreenContent surface="screen">
        {/* Hundreds of tasks stay cheap: only the rows in view mount. */}
        <LegendList<KinWorkRowView>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: 96 }}
          data={rows}
          keyExtractor={(row) => row.key}
          extraData={[listState, changed]}
          estimatedItemSize={68}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pt-2">
              {within?.header}
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
              onPress={() => openRecord("KinWorkItem", { environmentId, orgId, task: row.key })}
              onAct={canChange ? (action) => act(row.key, action) : null}
            />
          )}
        />
      </ScreenContent>
    </View>
  );
}

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
