import {
  KIN_MORE_FAILED,
  KIN_CHECK_CONNECTION,
  KIN_RETRY,
  kinFailure,
} from "@t3tools/client-runtime/kin/kinAnswers";
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
  kinListFilterCleared,
  kinListFilterLabel,
  kinListNothing,
  kinListRow,
  type KinListColumn,
  type KinListFilter,
  type KinListRowView,
} from "@t3tools/client-runtime/kin/kinLists";
import { KIN_MONEY_FORMS } from "@t3tools/client-runtime/kin/kinMoneyForms";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_HOME } from "@t3tools/client-runtime/kin/kinWorkHome";
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
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { KinMonthGrid } from "./components/KinMonthGrid";
import { KinWorkPlacePicker } from "./components/KinWorkPlacePicker";
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
import { KinLoadFailed } from "./components/KinLoadFailed";

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
// "No client" in the client filter: not a client, so its key can never be a record's.
const NO_CLIENT: KinWorkRef = { key: "none", title: KIN_LISTS.noClient };

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
            detail={KIN_CHECK_CONNECTION}
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
    const failure = kinFailure(lists.state._tag === "failed" ? lists.state.cause : null, "");
    const retry = !found && failure.retry;
    return (
      <KinWorkFrame title={KIN_LISTS.title} onBack={back}>
        <EmptyState
          variant="plain"
          title={found ? KIN_LISTS.listGone : KIN_LISTS.loadFailed}
          detail={found ? KIN_LISTS.goneDetail : failure.text.trim()}
          action={
            <Button
              tone="secondary"
              label={retry ? KIN_RETRY : "Back"}
              onPress={retry ? lists.refresh : back}
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

/** A list's one filter, like Tasks': its state, category and client, how it splits, and the table. */
function kinListFilterMenu(props: {
  readonly def: KinListDefinition;
  readonly filter: KinListFilter;
  readonly groupings: ReadonlyArray<KinListFilter["groupBy"]>;
  readonly table: boolean;
  readonly onTable: (table: boolean) => void;
  readonly onChange: (filter: KinListFilter) => void;
}): AppBarMenu {
  const { def, filter, onChange } = props;
  return {
    title: KIN_WORK_HOME.filter,
    icon: "line.3.horizontal.decrease.circle",
    items: [
      {
        id: "show",
        title: KIN_WORK_HOME.show,
        inline: true,
        items: kinListChips(def, filter).map((chip) => ({
          id: `show:${chip.id}`,
          title: chip.label,
          selected: chip.selected,
          onPress: () => onChange(chip.filter),
        })),
      },
      ...(def.categories.length === 0
        ? []
        : [
            {
              id: "category",
              title: KIN_LISTS.entry.category,
              items: [
                {
                  id: "category:any",
                  title: KIN_LISTS.anyCategory,
                  selected: filter.category === null && !filter.noCategory,
                  onPress: () => onChange({ ...filter, category: null, noCategory: false }),
                },
                ...def.categories.map((category) => ({
                  id: `category:${category}`,
                  title: kinCategoryLabel(category, def),
                  selected: filter.category === category,
                  onPress: () => onChange({ ...filter, category, noCategory: false }),
                })),
                {
                  id: "category:none",
                  title: KIN_LISTS.noCategory,
                  selected: filter.noCategory,
                  onPress: () => onChange({ ...filter, category: null, noCategory: true }),
                },
              ],
            },
          ]),
      ...(props.groupings.length <= 1
        ? []
        : [
            {
              id: "group",
              title: KIN_LISTS.groupBy,
              items: props.groupings.map((groupBy) => ({
                id: `group:${groupBy}`,
                title: groupBy === "none" ? "No grouping" : KIN_LISTS.group[groupBy],
                selected: groupBy === filter.groupBy,
                onPress: () => onChange({ ...filter, groupBy }),
              })),
            },
          ]),
      {
        id: "view",
        title: KIN_LISTS.view,
        inline: true,
        items: [
          {
            id: "view:rows",
            title: KIN_LISTS.rows,
            selected: !props.table,
            onPress: () => props.onTable(false),
          },
          {
            id: "view:table",
            title: KIN_LISTS.table,
            selected: props.table,
            onPress: () => props.onTable(true),
          },
        ],
      },
    ],
  };
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
  const canInvoice = useAtomValue(kinClient.workNewInvoice.permissionAtom(environmentId));
  const canExpense = useAtomValue(kinClient.workNewExpense.permissionAtom(environmentId));
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
  const header = kinListHeader(def, filter, totals, state.total, context.yearStartMonth);
  const rows = state.records.map((record) =>
    kinListRow(record, def, context, { party: filter.party?.key ?? null }),
  );
  const narrowed = kinListFilterLabel(def, filter);
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
  const target = { environmentId: String(environmentId), orgId: String(orgId) };
  // Invoices and Expenses take a new one typed by hand; no other list has a form of its own.
  const add =
    def.archivedAt !== null
      ? null
      : def.list === "invoices" && canInvoice
        ? {
            accessibilityLabel: KIN_MONEY_FORMS.invoice.title,
            icon: "plus" as const,
            onPress: () =>
              navigation.navigate("KinInvoiceNew", {
                ...target,
                ...(filter.party === null
                  ? {}
                  : { party: filter.party.key, partyName: filter.party.title }),
              }),
          }
        : def.list === "expenses" && canExpense
          ? {
              accessibilityLabel: KIN_MONEY_FORMS.expense.title,
              icon: "plus" as const,
              onPress: () => navigation.navigate("KinExpenseNew", target),
            }
          : null;
  const actions = [
    ...(add === null ? [] : [add]),
    ...(canEdit && !def.builtIn
      ? [
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
        ]
      : []),
  ];
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={def.name}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: retry }}
        menus={[
          kinListFilterMenu({
            def,
            filter,
            groupings,
            table,
            onTable: setTable,
            onChange: entries.setFilter,
          }),
        ]}
        {...(actions.length === 0 ? {} : { actions })}
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
              <View className="px-4">
                <ListSection>
                  <KinWorkPlacePicker
                    target={props}
                    noun="client"
                    icon="person.2"
                    label={KIN_LISTS.clientFilter}
                    none={KIN_LISTS.anyClient}
                    extra={NO_CLIENT}
                    held={filter.noParty ? NO_CLIENT : filter.party}
                    choices={clients}
                    disabled={false}
                    onPick={(party) =>
                      entries.setFilter(
                        party?.key === NO_CLIENT.key
                          ? { ...filter, noParty: true, party: null }
                          : { ...filter, noParty: false, party },
                      )
                    }
                  />
                </ListSection>
              </View>
              {narrowed === null ? null : (
                <View className="flex-row px-4">
                  <Chip
                    label={narrowed}
                    selected
                    trailingIcon="xmark"
                    accessibilityLabel={`Showing ${narrowed}. ${KIN_WORK_HOME.clearFilter}`}
                    onPress={() => entries.setFilter(kinListFilterCleared(filter))}
                  />
                </View>
              )}
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
                  <KinLoadFailed
                    title={KIN_LISTS.entriesFailed}
                    cause={state.failed}
                    onRetry={entries.refresh}
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
                  {state.moreFailed ? KIN_MORE_FAILED : footer}
                </Text>
                {state.more ? (
                  <Button
                    tone="secondary"
                    size="compact"
                    label={state.moreFailed ? KIN_RETRY : "Show more"}
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
          <KinLoadFailed title={KIN_DATES.loadFailed} cause={null} onRetry={retry} />
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
