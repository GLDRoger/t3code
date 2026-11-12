import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_DATES,
  kinAgendaWindow,
  kinDatesAgenda,
  kinDatesMonth,
  kinMonthWindow,
  kinOwnerToday,
  kinShiftMonth,
} from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_LISTS,
  kinCategoryLabel,
  kinListChips,
  kinListColumns,
  kinListFilterParam,
  kinListFooter,
  kinListGroupings,
  kinListHeader,
  kinListNarrowings,
  kinListNothing,
  kinListRow,
  type KinListColumn,
  type KinListFilter,
  type KinListRowView,
} from "@t3tools/client-runtime/kin/kinLists";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  EnvironmentId,
  KinListId,
  KinOrgId,
  type KinListDefinition,
  type KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { KinMonthGrid } from "./components/KinMonthGrid";
import { KinWorkFrame, KinWorkLoading, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { KinWorkStateSymbol } from "./components/KinWorkStateSymbol";
import { KinDateRowLine } from "./KinWorkMoney";
import { kinClient } from "./state/kinClient";
import {
  useKinDates,
  useKinListContext,
  useKinListEntries,
  useKinLists,
} from "./state/useKinMoney";
import {
  refreshKinWorkLive,
  useKinWork,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

export type KinListParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly list: string;
  /** A filter to open narrowed to, as a Money figure passes it. */
  readonly filter?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeList = Schema.decodeUnknownOption(KinListId);

/** One list an agent set up, whatever it holds: its entries, narrowed and added up. */
export function KinListScreen({ route }: StaticScreenProps<KinListParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const list = Option.getOrNull(decodeList(route.params.list));
  if (environmentId === null || orgId === null || list === null) {
    return (
      <KinWorkFrame title={KIN_LISTS.title} onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't open a list"
          detail="Open Lists from Work."
        />
      </KinWorkFrame>
    );
  }
  // A fresh reader per list and filter: a link to another list never shows this one's rows.
  return (
    <KinListGate
      key={`${list}:${route.params.filter ?? ""}`}
      environmentId={environmentId}
      orgId={orgId}
      list={list}
      initial={kinListFilterParam(route.params.filter)}
    />
  );
}

function KinListGate(
  props: KinWorkTarget & { readonly list: KinListId; readonly initial: KinListFilter },
) {
  const navigation = useNavigation();
  const work = useKinWork(props);
  const ready = work._tag === "ready";
  const directory = useKinWorkDirectory(props, ready);
  const lists = useKinLists(props, {
    enabled: ready,
    archived: true,
    seq: ready && !work.stale ? work.live.seq : null,
  });
  const back = () => navigation.goBack();
  if (work._tag === "refused" || lists.state._tag === "refused") {
    return (
      <KinWorkFrame title={KIN_LISTS.title} onBack={back}>
        <EmptyState variant="plain" {...KIN_LISTS.onlyOwner} />
      </KinWorkFrame>
    );
  }
  if (work._tag !== "ready" || lists.state._tag === "loading") {
    return (
      <KinWorkFrame title={KIN_LISTS.title} onBack={back}>
        {work._tag === "failed" || work._tag === "offline" ? (
          <EmptyState
            variant="plain"
            title={KIN_LISTS.entriesFailed}
            detail="Check your connection to the server and try again."
          />
        ) : (
          <KinWorkLoading label="Loading list" />
        )}
      </KinWorkFrame>
    );
  }
  const def =
    lists.state._tag === "ready"
      ? lists.state.value.lists.find((one) => one.list === props.list)
      : undefined;
  if (def === undefined) {
    const found = lists.state._tag === "ready";
    return (
      <KinWorkFrame title={KIN_LISTS.title} onBack={back}>
        <EmptyState
          variant="plain"
          title={found ? "This list isn't here" : KIN_LISTS.loadFailed}
          detail={
            found
              ? "It may have been renamed. Open Lists to see what there is."
              : "Check your connection to the server and try again."
          }
          action={
            <Button
              tone="secondary"
              label={found ? "Back" : "Try again"}
              onPress={found ? back : lists.refresh}
            />
          }
        />
      </KinWorkFrame>
    );
  }
  return (
    <KinListEntries
      {...props}
      def={def}
      live={work.live}
      stale={work.stale}
      directory={directory}
    />
  );
}

const GROUP = "group:";
const PICK = "pick:";
const ANY = "any";
const NONE = "none";

/** A chip that narrows the list to one of a few things, to none of them, or not at all. */
function NarrowMenu(props: {
  readonly title: string;
  readonly any: string;
  readonly none: string;
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** A choice's value, `NONE`, or `ANY`. */
  readonly current: string;
  readonly onPick: (value: string) => void;
}) {
  const shown =
    props.current === ANY
      ? props.title
      : props.current === NONE
        ? props.none
        : (props.choices.find((choice) => choice.value === props.current)?.label ?? props.title);
  return (
    <Menu
      title={props.title}
      accessibilityRole="button"
      accessibilityLabel={`${props.title}: ${props.current === ANY ? props.any : shown}. Change`}
      actions={[
        { id: ANY, title: props.any, state: props.current === ANY ? "on" : "off" },
        ...props.choices.map((choice) => ({
          id: `${PICK}${choice.value}`,
          title: choice.label,
          state: choice.value === props.current ? ("on" as const) : ("off" as const),
        })),
        { id: NONE, title: props.none, state: props.current === NONE ? "on" : "off" },
      ]}
      onPressAction={({ nativeEvent: { event } }) =>
        props.onPick(event.startsWith(PICK) ? event.slice(PICK.length) : event)
      }
    >
      <View pointerEvents="none">
        <Chip
          size="small"
          label={shown}
          selected={props.current !== ANY}
          trailingIcon="chevron.down"
        />
      </View>
    </Menu>
  );
}

const TABLE_ROW = "h-14 justify-center border-b border-border-subtle px-3";

/**
 * The list as a table on a phone: the entry's name stays put while its columns scroll sideways.
 * Rows keep one height, so the pinned names and the scrolling cells stay on the same line.
 */
function KinListTable(props: {
  readonly columns: ReadonlyArray<KinListColumn>;
  readonly rows: ReadonlyArray<KinListRowView>;
  readonly onOpen: (key: KinRecordKey) => void;
}) {
  const [first, ...rest] = props.columns;
  if (first === undefined) return null;
  return (
    <View className="flex-row border-t border-border-subtle">
      <View className="w-40 border-r border-border bg-screen">
        <View className={`${TABLE_ROW} bg-grouped-card`}>
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            {first.label}
          </Text>
        </View>
        {props.rows.map((row) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={row.accessibilityLabel}
            onPress={() => props.onOpen(row.key)}
            className={`${TABLE_ROW} active:opacity-60`}
          >
            <Text
              textRole="footnote"
              numberOfLines={2}
              className={row.closed ? "text-foreground-muted" : "text-foreground"}
            >
              {row.cells[first.id] ?? ""}
            </Text>
          </Pressable>
        ))}
      </View>
      <ScrollView horizontal className="flex-1" keyboardShouldPersistTaps="handled">
        <View>
          <View className="flex-row bg-grouped-card">
            {rest.map((column) => (
              <View key={column.id} className={`${TABLE_ROW} w-32`}>
                <Text
                  textRole="footnote"
                  numberOfLines={1}
                  className={
                    column.numeric
                      ? "text-right font-t3-medium text-foreground-muted"
                      : "font-t3-medium text-foreground-muted"
                  }
                >
                  {column.label}
                </Text>
              </View>
            ))}
          </View>
          {props.rows.map((row) => (
            <Pressable
              key={row.key}
              accessible={false}
              onPress={() => props.onOpen(row.key)}
              className="flex-row active:opacity-60"
            >
              {rest.map((column) => (
                <View key={column.id} className={`${TABLE_ROW} w-32`}>
                  <Text
                    textRole="footnote"
                    numberOfLines={2}
                    className={
                      column.numeric
                        ? "text-right tabular-nums text-foreground"
                        : column.id === "due" && row.late
                          ? "text-danger-foreground"
                          : "text-foreground"
                    }
                  >
                    {row.cells[column.id] ?? ""}
                  </Text>
                </View>
              ))}
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function KinListEntries(
  props: KinWorkTarget & {
    readonly def: KinListDefinition;
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly initial: KinListFilter;
  },
) {
  const navigation = useNavigation();
  const { def, environmentId, orgId } = props;
  const context = useKinListContext(props, props.directory);
  const canEdit = useAtomValue(kinClient.workListUpdate.permissionAtom(environmentId));
  const { state, entries, totals } = useKinListEntries(
    props,
    def.list,
    props.initial,
    props.stale ? null : props.live.seq,
  );
  const { filter } = state;
  const { refresh } = entries;
  const rev = useRef(def.rev);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the host adds a list up by its settings, so its figures are read again when those change
  useEffect(() => {
    if (rev.current === def.rev) return;
    rev.current = def.rev;
    refresh();
  }, [def.rev, refresh]);
  const header = kinListHeader(def, filter, totals, state.total);
  const rows = state.records.map((record) =>
    kinListRow(record, def, context, { party: filter.party?.key ?? null }),
  );
  const narrowings = kinListNarrowings(filter, def).filter(
    // The category and client chips already say what they are narrowed to.
    (narrowing) =>
      !(narrowing.id === "category" && def.categories.length > 0) && narrowing.id !== "party",
  );
  const { clients } = useKinWorkChoices(props, true);
  const [table, setTable] = useState(false);
  const columns = kinListColumns(def, state.records);
  const groupings = kinListGroupings(def);
  const nothing = kinListNothing(def, filter);
  const footer = kinListFooter(rows.length, state.total, state.more);
  const open = (task: KinRecordKey) =>
    navigation.navigate("KinWorkItem", { environmentId, orgId, task });
  const retry = () => {
    refreshKinWorkLive(props);
    entries.refresh();
  };
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={def.name}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: retry }}
        {...(canEdit && !def.builtIn
          ? {
              actions: [
                {
                  accessibilityLabel: KIN_LISTS.edit.title,
                  icon: "slider.horizontal.3" as const,
                  onPress: () =>
                    navigation.navigate("KinListSettings", {
                      environmentId,
                      orgId,
                      list: def.list,
                    }),
                },
              ],
            }
          : {})}
        search={{
          value: filter.text,
          onChangeText: (text) => entries.setFilter({ ...filter, text }),
          placeholder: KIN_LISTS.search,
          closeAccessibilityLabel: "Close search",
          clearAccessibilityLabel: "Clear search",
        }}
      />
      <ScreenContent surface="screen">
        <LegendList<KinListRowView>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: 96 }}
          data={table ? [] : rows}
          keyExtractor={(row) => row.key}
          extraData={state}
          estimatedItemSize={68}
          recycleItems
          onEndReached={() => void entries.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pb-1 pt-2">
              {props.stale || state.stale ? (
                <View className="px-4">
                  <KinWorkStaleNotice environmentId={environmentId} onRetry={retry} />
                </View>
              ) : null}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
              >
                {kinListChips(def, filter).map((chip) => (
                  <Chip
                    key={chip.id}
                    label={chip.label}
                    selected={chip.selected}
                    onPress={() => entries.setFilter(chip.filter)}
                  />
                ))}
              </ScrollView>
              {
                <View className="flex-row flex-wrap gap-2 px-4">
                  <Chip
                    size="small"
                    icon="square.split.2x1"
                    label={KIN_LISTS.table}
                    accessibilityLabel={`${KIN_LISTS.table}. ${table ? "On" : "Off"}`}
                    selected={table}
                    onPress={() => setTable(!table)}
                  />
                  {def.categories.length === 0 ? null : (
                    <NarrowMenu
                      title={KIN_LISTS.entry.category}
                      any={KIN_LISTS.anyCategory}
                      none={KIN_LISTS.noCategory}
                      choices={def.categories.map((category) => ({
                        value: category,
                        label: kinCategoryLabel(category, def),
                      }))}
                      current={filter.noCategory ? NONE : (filter.category ?? ANY)}
                      onPick={(value) =>
                        entries.setFilter({
                          ...filter,
                          noCategory: value === NONE,
                          category: value === NONE || value === ANY ? null : value,
                        })
                      }
                    />
                  )}
                  <NarrowMenu
                    title={KIN_LISTS.clientFilter}
                    any={KIN_LISTS.anyClient}
                    none={KIN_LISTS.noClient}
                    choices={[
                      ...clients,
                      // A client arrived at from elsewhere stays named though it isn't a choice.
                      ...(filter.party === null ||
                      clients.some((held) => held.key === filter.party?.key)
                        ? []
                        : [filter.party]),
                    ].map((held) => ({ value: held.key, label: held.title }))}
                    current={filter.noParty ? NONE : (filter.party?.key ?? ANY)}
                    onPick={(value) =>
                      entries.setFilter({
                        ...filter,
                        noParty: value === NONE,
                        party:
                          value === NONE || value === ANY
                            ? null
                            : (clients.find((held) => held.key === value) ?? filter.party),
                      })
                    }
                  />
                  {groupings.length <= 1 ? null : (
                    <Menu
                      title={KIN_LISTS.groupBy}
                      accessibilityRole="button"
                      accessibilityLabel={`${KIN_LISTS.groupBy}: ${KIN_LISTS.group[filter.groupBy]}. Change`}
                      actions={groupings.map((groupBy) => ({
                        id: `${GROUP}${groupBy}`,
                        title: groupBy === "none" ? "No grouping" : KIN_LISTS.group[groupBy],
                        state: groupBy === filter.groupBy ? ("on" as const) : ("off" as const),
                      }))}
                      onPressAction={({ nativeEvent: { event } }) => {
                        const groupBy = groupings.find((held) => `${GROUP}${held}` === event);
                        if (groupBy !== undefined) entries.setFilter({ ...filter, groupBy });
                      }}
                    >
                      <View pointerEvents="none">
                        <Chip
                          size="small"
                          label={
                            filter.groupBy === "none"
                              ? KIN_LISTS.groupBy
                              : `By ${KIN_LISTS.group[filter.groupBy].toLowerCase()}`
                          }
                          selected={filter.groupBy !== "none"}
                          trailingIcon="chevron.down"
                        />
                      </View>
                    </Menu>
                  )}
                  {narrowings.map((narrowing) => (
                    <Chip
                      key={narrowing.id}
                      size="small"
                      label={narrowing.label}
                      accessibilityLabel={`${narrowing.label}. Clear`}
                      selected
                      trailingIcon="xmark"
                      onPress={() => entries.setFilter(narrowing.cleared)}
                    />
                  ))}
                </View>
              }
              {state.loading || state.failed !== null ? null : (
                <View className="flex-row flex-wrap items-end gap-x-6 gap-y-2 px-5">
                  {header.figures.map((figure, index) => (
                    <View key={figure.id} className="gap-0.5">
                      {figure.label === null ? null : (
                        <Text textRole="footnote" className="text-foreground-muted">
                          {figure.label}
                        </Text>
                      )}
                      {figure.lines.map((line) => (
                        <Text
                          key={line}
                          textRole={index === 0 ? "title" : "body"}
                          selectable
                          className={
                            index === 0
                              ? "font-t3-bold tabular-nums text-foreground"
                              : "tabular-nums text-foreground"
                          }
                        >
                          {line}
                        </Text>
                      ))}
                    </View>
                  ))}
                  {header.count === null ? null : (
                    <Text textRole="footnote" className="pb-0.5 text-foreground-muted">
                      {header.count}
                    </Text>
                  )}
                </View>
              )}
              {header.groups.length === 0 ? null : (
                <View className="px-4">
                  <ListSection>
                    {header.groups.map((group) => {
                      const { narrowed } = group;
                      return (
                        <Pressable
                          key={group.key}
                          accessibilityRole={narrowed === null ? "text" : "button"}
                          accessibilityState={{ selected: group.selected }}
                          accessibilityLabel={[
                            group.label,
                            group.count,
                            ...group.totals,
                            group.billed,
                          ]
                            .filter((part) => part !== null)
                            .join(". ")}
                          disabled={narrowed === null}
                          onPress={() =>
                            narrowed === null ? undefined : entries.setFilter(narrowed)
                          }
                          className="min-h-11 flex-row items-center gap-3 bg-grouped-card px-4 py-2.5 active:opacity-60"
                        >
                          <View className="min-w-0 flex-1">
                            <Text
                              textRole="body"
                              numberOfLines={1}
                              className={
                                group.selected
                                  ? "font-t3-medium text-foreground"
                                  : "text-foreground"
                              }
                            >
                              {group.label}
                            </Text>
                            <Text textRole="footnote" className="text-foreground-muted">
                              {group.count}
                            </Text>
                          </View>
                          <View className="items-end">
                            {group.totals.map((line) => (
                              <Text
                                key={line}
                                textRole="body"
                                className="tabular-nums text-foreground"
                              >
                                {line}
                              </Text>
                            ))}
                            {group.billed === null ? null : (
                              <Text
                                textRole="footnote"
                                className="tabular-nums text-foreground-muted"
                              >
                                {group.billed}
                              </Text>
                            )}
                          </View>
                        </Pressable>
                      );
                    })}
                  </ListSection>
                </View>
              )}
              {table && rows.length > 0 ? (
                <KinListTable columns={columns} rows={rows} onOpen={open} />
              ) : null}
            </View>
          }
          ListEmptyComponent={
            table && rows.length > 0 ? null : (
              <View className="px-4 pt-4">
                {state.loading ? (
                  <KinWorkLoading label="Loading entries" />
                ) : state.failed !== null ? (
                  <EmptyState
                    variant="plain"
                    title={KIN_LISTS.entriesFailed}
                    detail="Check your connection to the server and try again."
                    action={<Button tone="secondary" label="Try again" onPress={entries.refresh} />}
                  />
                ) : (
                  <EmptyState variant="plain" {...nothing} />
                )}
              </View>
            )
          }
          ListFooterComponent={
            footer === null ? null : (
              <View className="items-start gap-2 px-5 py-4">
                <Text textRole="footnote" className="text-foreground-muted">
                  {state.moreFailed ? "Couldn't load more." : footer}
                </Text>
                {state.more ? (
                  <Button
                    tone="secondary"
                    size="compact"
                    label={state.moreFailed ? "Try again" : "Show more"}
                    loading={state.loadingMore}
                    disabled={state.loadingMore}
                    onPress={() => void entries.loadMore()}
                  />
                ) : null}
              </View>
            )
          }
          renderItem={({ item: row }) => <KinListRowLine row={row} onPress={() => open(row.key)} />}
        />
      </ScreenContent>
    </View>
  );
}

/** One entry of any list: its name, what the list says about it, and its amount when it has one. */
export function KinListRowLine(props: {
  readonly row: KinListRowView;
  readonly onPress: () => void;
  /** Inside a rounded section the row keeps to the section's edges. */
  readonly inset?: boolean;
}) {
  const { row } = props;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.accessibilityLabel}
        onPress={props.onPress}
        className={
          props.inset
            ? "min-h-16 flex-row items-start bg-grouped-card pr-4 active:opacity-60"
            : "min-h-16 flex-row items-start pr-5 active:opacity-60"
        }
      >
        <View className="h-12 w-12 items-center justify-center pl-2">
          <KinWorkStateSymbol state={row.state} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5 py-3">
          <Text
            textRole="body"
            numberOfLines={2}
            className={row.closed ? "text-foreground-muted" : "text-foreground"}
          >
            {row.title}
          </Text>
          <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
            {row.line}
          </Text>
        </View>
        <View className="items-end gap-0.5 py-3 pl-3">
          {row.amount === null ? null : (
            <Text textRole="body" className="tabular-nums text-foreground">
              {row.amount}
            </Text>
          )}
          {row.owed === null ? null : (
            <Text textRole="footnote" className="tabular-nums text-foreground-muted">
              {row.owed}
            </Text>
          )}
          {row.late ? (
            <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
              {KIN_LISTS.late}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <View className="ml-12 h-px bg-border-subtle" />
    </>
  );
}

export type KinDatesParams = { readonly environmentId: string; readonly orgId: string };

/** Everything with a date, across every list, a day at a time. */
export function KinDatesScreen({ route }: StaticScreenProps<KinDatesParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <KinWorkFrame title={KIN_DATES.title} onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open Work from your Kin chats."
        />
      </KinWorkFrame>
    );
  }
  return <KinDatesBody environmentId={environmentId} orgId={orgId} />;
}

function KinDatesBody(props: KinWorkTarget) {
  const navigation = useNavigation();
  const work = useKinWork(props);
  const ready = work._tag === "ready";
  const { names } = useKinWorkDirectory(props, ready);
  const now = new Date(useNowMinuteMs());
  const [openOnly, setOpenOnly] = useState(true);
  const today = kinOwnerToday(now, names);
  const [mode, setMode] = useState<"agenda" | "month">("agenda");
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const { state, retry } = useKinDates(
    props,
    !ready
      ? null
      : mode === "agenda"
        ? kinAgendaWindow(today, names.zone)
        : kinMonthWindow(month, names.zone),
    openOnly,
    ready && !work.stale ? work.live.seq : null,
  );
  const frame = {
    title: KIN_DATES.title,
    onBack: () => navigation.goBack(),
    refresh: { accessibilityLabel: "Refresh", onPress: retry },
  };
  if (work._tag === "refused") {
    return (
      <KinWorkFrame {...frame}>
        <EmptyState variant="plain" {...KIN_LISTS.onlyOwner} />
      </KinWorkFrame>
    );
  }
  const failed = state._tag === "failed" || work._tag === "failed" || work._tag === "offline";
  const modes = (
    <View className="flex-row gap-2 px-2">
      <Chip
        label={KIN_DATES.agenda}
        selected={mode === "agenda"}
        onPress={() => setMode("agenda")}
      />
      <Chip label={KIN_DATES.month} selected={mode === "month"} onPress={() => setMode("month")} />
    </View>
  );
  // A month keeps its grid while its entries are read, so stepping through months never blanks.
  if (mode === "month" && ready && !failed) {
    const grid = kinDatesMonth(month, state._tag === "ready" ? state.rows : [], names, now);
    const day = picked !== null && picked.startsWith(month) ? picked : null;
    const shown = day ?? (today.startsWith(month) ? today : null);
    const rows = grid.weeks.flat().find((cell) => cell.day === shown)?.rows ?? [];
    const dated = grid.weeks.flat().filter((cell) => cell.inMonth && cell.rows.length > 0);
    return (
      <KinWorkFrame {...frame}>
        {modes}
        <ListSection>
          <ListToggleRow label={KIN_DATES.openOnly} value={openOnly} onValueChange={setOpenOnly} />
        </ListSection>
        <KinMonthGrid
          label={grid.label}
          weeks={grid.weeks}
          selected={shown}
          onPick={(next) => {
            setPicked(next);
            if (!next.startsWith(month)) setMonth(next.slice(0, 7));
          }}
          onShift={(by) => setMonth(kinShiftMonth(month, by))}
        />
        {state._tag !== "ready" ? (
          <KinWorkLoading label="Loading dates" />
        ) : shown !== null && rows.length > 0 ? (
          <ListSection title={rows[0]?.when ?? shown}>
            {rows.map((row) => (
              <KinDateRowLine
                key={row.id}
                row={row}
                onPress={() => navigation.navigate("KinWorkItem", { ...props, task: row.key })}
              />
            ))}
          </ListSection>
        ) : (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {dated.length === 0
              ? "Nothing dated this month."
              : shown === null
                ? "Tap a day with a dot to see what falls on it."
                : "Nothing on this day."}
          </Text>
        )}
      </KinWorkFrame>
    );
  }
  if (state._tag !== "ready") {
    return (
      <KinWorkFrame {...frame}>
        {failed ? (
          <EmptyState
            variant="plain"
            title={KIN_DATES.loadFailed}
            detail="Check your connection to the server and try again."
            action={<Button tone="secondary" label="Try again" onPress={retry} />}
          />
        ) : (
          <KinWorkLoading label="Loading dates" />
        )}
      </KinWorkFrame>
    );
  }
  const days = kinDatesAgenda(state.rows, names, now);
  return (
    <KinWorkFrame {...frame}>
      {modes}
      <ListSection>
        <ListToggleRow label={KIN_DATES.openOnly} value={openOnly} onValueChange={setOpenOnly} />
      </ListSection>
      {days.length === 0 ? (
        <EmptyState variant="plain" {...KIN_DATES.none} />
      ) : (
        days.map((day) => (
          <ListSection key={day.day} title={day.label}>
            {day.rows.map((row) => (
              <KinDateRowLine
                key={row.id}
                row={row}
                onPress={() => navigation.navigate("KinWorkItem", { ...props, task: row.key })}
              />
            ))}
          </ListSection>
        ))
      )}
      {state.more ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_DATES.more}
        </Text>
      ) : null}
    </KinWorkFrame>
  );
}
