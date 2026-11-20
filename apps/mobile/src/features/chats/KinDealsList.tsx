import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import {
  KIN_DEAL_NUMBERS,
  kinDealFigures,
  kinDealMonthRows,
  kinDealPeopleRows,
  kinDealWeekGroups,
  KIN_DEALS,
  KIN_DEALS_STATES,
  kinDealConcernRows,
  kinDealRow,
  kinDealsByStage,
  kinDealsHeader,
  kinDealsQuery,
  kinDealsNothing,
  kinDealsNotRead,
  kinDealsSection,
  type KinDealNextView,
  type KinDealRowView,
  type KinDealsFilter,
} from "@t3tools/client-runtime/kin/kinDeals";
import { KIN_WORK_HOME } from "@t3tools/client-runtime/kin/kinWorkHome";
import { KIN_CLIENTS } from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinDealNumbers, KinDealsResult, KinPersonId, KinRecordKey } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { kinTabBar, useKinTab, kinTabFoot } from "./components/KinTab";
import { KinLoadFailed } from "./components/KinLoadFailed";
import {
  KinFoldSection,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkStaleNotice,
} from "./components/KinWorkPieces";
import { useKinIsOwnerLevel } from "./state/kinChatOnly";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinDeals, useKinDealsStart } from "./state/useKinDeals";
import { useKinRates } from "./state/useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./state/useKinWork";

const TONE: Record<KinDealNextView["tone"], string> = {
  plain: "text-foreground-muted",
  missing: "text-warning-foreground",
  late: "text-danger-foreground",
};

/** A deal's next step, or that it has none (amber), or that it is late (red). */
export function KinDealNextLine(props: { readonly next: KinDealNextView | null }) {
  if (props.next === null) return null;
  return (
    <Text textRole="footnote" numberOfLines={1} className={TONE[props.next.tone]}>
      {props.next.text}
    </Text>
  );
}

/** One deal as a row that opens it: what, for whom, its value and its next step. */
export function KinDealRowButton(props: {
  readonly row: KinDealRowView;
  readonly pill?: string;
  /** Inside a rounded section the divider keeps to the section's edges. */
  readonly inset?: boolean;
  /** Shown under the row, such as why it was lost. */
  readonly note?: string | null;
  readonly onPress: () => void;
}) {
  const { row } = props;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.accessibilityLabel}
        onPress={props.onPress}
        className={cn(
          "min-h-16 flex-row items-start gap-3 py-3 active:opacity-60",
          props.inset ? "bg-grouped-card px-4" : "px-5",
        )}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text textRole="body" numberOfLines={2} className="min-w-0 shrink text-foreground">
              {row.title}
            </Text>
            {row.private ? <KinWorkPrivateMark label="" /> : null}
          </View>
          {row.line === "" ? null : (
            <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
              {row.line}
            </Text>
          )}
          <KinDealNextLine next={row.next} />
          {props.note == null ? null : (
            <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
              {props.note}
            </Text>
          )}
        </View>
        <View className="shrink-0 items-end gap-1">
          {row.value === null ? null : (
            <Text textRole="body" className="text-foreground tabular-nums">
              {row.value}
            </Text>
          )}
          {props.pill === undefined ? null : (
            <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
              {props.pill}
            </Text>
          )}
        </View>
      </Pressable>
      <View className={cn("h-px bg-border-subtle", props.inset ? "ml-4" : "ml-5")} />
    </>
  );
}

type Item =
  | {
      readonly type: "stage";
      readonly id: string;
      readonly name: string;
      readonly count: number;
      readonly total: string;
    }
  | {
      readonly type: "deal";
      readonly id: string;
      readonly row: KinDealRowView;
      readonly note: string | null;
    };

const matches = (text: string, ...parts: ReadonlyArray<string>) => {
  const folded = text.trim().toLocaleLowerCase();
  return folded === "" || parts.some((part) => part.toLocaleLowerCase().includes(folded));
};

/** Which deals and whose, as the bar's one Show menu. */
function dealsMenu(
  filter: KinDealsFilter,
  onFilter: (filter: KinDealsFilter) => void,
  names: KinWorkNames,
): AppBarMenu {
  const people = [...names.people.entries()].filter(([id]) => id !== names.me);
  return {
    title: KIN_WORK_HOME.show,
    icon: "line.3.horizontal.decrease.circle",
    items: [
      {
        id: "which",
        title: KIN_DEALS.which,
        inline: true,
        items: KIN_DEALS_STATES.map((state) => ({
          id: `which:${state.id}`,
          title: state.label,
          selected: filter.state === state.id,
          onPress: () => onFilter({ ...filter, state: state.id }),
        })),
      },
      {
        id: "whose",
        title: KIN_DEALS.whose,
        inline: true,
        items: [
          {
            id: "whose:everyone",
            title: KIN_DEALS.everyone,
            selected: filter.who._tag === "everyone",
            onPress: () => onFilter({ ...filter, who: { _tag: "everyone" } }),
          },
          {
            id: "whose:me",
            title: KIN_DEALS.mine,
            selected: filter.who._tag === "me",
            onPress: () => onFilter({ ...filter, who: { _tag: "me" } }),
          },
          ...(people.length === 0
            ? []
            : [
                {
                  id: "whose:someone",
                  title: KIN_DEALS.someone,
                  items: people.map(([id, name]) => ({
                    id: `whose:${id}`,
                    title: name,
                    selected: filter.who._tag === "person" && filter.who.personId === id,
                    onPress: () =>
                      onFilter({
                        ...filter,
                        who: { _tag: "person", personId: id as KinPersonId },
                      }),
                  })),
                },
              ]),
        ],
      },
    ],
  };
}

/** The Deals tab on the phone: open deals under each stage, won and lost under Show. */
const WAITING: KinDealsFilter = { who: { _tag: "everyone" }, state: "open" };

export function KinDealsView(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly stale: boolean;
    /** Which of Clients, Deals and Projects shows. */
    readonly header: React.ReactNode;
    readonly ask: AppBarAction | null;
  },
) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const { environmentId, orgId } = props;
  const { names } = props.directory;
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  const start = useKinDealsStart(environmentId);
  const [chosen, setFilter] = useState<KinDealsFilter | null>(null);
  const query = kinDealsQuery(orgId, chosen, start, names.me);
  // Until the host says who this is nothing is read, and nothing says "Mine" on a guess.
  const filter = query?.filter ?? WAITING;
  const [text, setText] = useState("");
  const { state, refresh } = useKinDeals(props, query?.input ?? null);
  const notRead = kinDealsNotRead(state);
  const rates = useKinRates(props, ownerLevel);
  const now = new Date(useNowMinuteMs());
  const result = state._tag === "ready" ? state.value : null;
  const deals = (result?.deals ?? []).filter((deal) => matches(text, deal.title, deal.party.title));
  const items: ReadonlyArray<Item> =
    result === null
      ? []
      : filter.state === "open"
        ? kinDealsByStage(result.stages, deals, names, now).flatMap((column) =>
            column.count === 0
              ? []
              : [
                  {
                    type: "stage" as const,
                    id: `stage:${column.id}`,
                    name: column.name,
                    count: column.count,
                    total: column.total,
                  },
                  ...column.rows.map((row) => ({
                    type: "deal" as const,
                    id: row.key,
                    row,
                    note: null,
                  })),
                ],
          )
        : deals.map((deal) => ({
            type: "deal" as const,
            id: deal.key,
            row: kinDealRow(deal, names, now),
            note: deal.lostReason === undefined ? null : KIN_DEALS.lostWhy(deal.lostReason),
          }));
  const header = result === null ? null : kinDealsHeader(result.open, rates);
  const add =
    result?.canCreate === true
      ? () => navigation.navigate("KinDealNew", { environmentId, orgId })
      : null;
  const open = (deal: KinRecordKey) =>
    navigation.navigate("KinDeal", { environmentId, orgId, deal });
  const nothing = kinDealsNothing(filter);

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        // The place's own name, as on its Clients and Projects tabs.
        title={KIN_CLIENTS.title}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        actions={[
          ...(props.ask === null ? [] : [props.ask]),
          ...(add === null
            ? []
            : [{ accessibilityLabel: KIN_DEALS.newDeal, icon: "plus" as const, onPress: add }]),
        ]}
        menus={[dealsMenu(filter, setFilter, names)]}
        {...kinTabBar(tab, {
          onBack: () => navigation.goBack(),
          search: {
            value: text,
            onChangeText: setText,
            placeholder: KIN_DEALS.search,
            closeAccessibilityLabel: "Close search",
            clearAccessibilityLabel: "Clear search",
          },
        })}
      />
      <ScreenContent surface="screen">
        <LegendList<Item>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field, or the dock, floats over the foot of the list.
          contentContainerStyle={{
            paddingBottom: tab === null ? 96 : kinTabFoot(tab.bottomClearance),
          }}
          data={items}
          keyExtractor={(item) => item.id}
          getItemType={(item) => item.type}
          extraData={state}
          estimatedItemSize={80}
          recycleItems
          ListHeaderComponent={
            <View className="gap-3 px-4 pt-2">
              {props.header}
              {props.stale || (state._tag === "ready" && state.stale) ? (
                <KinWorkStaleNotice environmentId={environmentId} onRetry={refresh} />
              ) : null}
              {header === null || (result?.deals.length ?? 0) === 0 ? null : (
                <ListSection>
                  <View
                    accessible
                    accessibilityLabel={[
                      `${KIN_DEALS.open}: ${header.count}`,
                      ...header.values,
                      header.estimate,
                    ]
                      .filter((part) => part !== null)
                      .join(". ")}
                    className="gap-0.5 bg-grouped-card px-4 py-3"
                  >
                    <Text textRole="footnote" className="text-foreground-muted">
                      {KIN_DEALS.open}
                    </Text>
                    {header.values.map((line) => (
                      <Text
                        key={line}
                        textRole="headline"
                        className="font-t3-medium text-foreground tabular-nums"
                      >
                        {line}
                      </Text>
                    ))}
                    <Text
                      textRole={header.values.length === 0 ? "headline" : "footnote"}
                      className={
                        header.values.length === 0
                          ? "font-t3-medium text-foreground"
                          : "text-foreground-muted"
                      }
                    >
                      {header.count}
                    </Text>
                    {header.estimate === null ? null : (
                      <Text textRole="footnote" className="text-foreground-muted">
                        {KIN_DEALS.estimate(header.estimate)}
                      </Text>
                    )}
                  </View>
                  <DealFigures numbers={result?.numbers} />
                </ListSection>
              )}
              {filter.who._tag === "everyone" ? null : (
                <View className="flex-row">
                  <Chip
                    selected
                    icon="xmark"
                    label={
                      filter.who._tag === "me"
                        ? KIN_DEALS.mine
                        : (names.people.get(filter.who.personId) ?? KIN_DEALS.someone)
                    }
                    accessibilityLabel={`${KIN_DEALS.whose}: ${KIN_DEALS.everyone}`}
                    onPress={() => setFilter({ ...filter, who: { _tag: "everyone" } })}
                  />
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            <View className="px-4 pt-4">
              {state._tag === "loading" ? (
                <KinWorkLoading label={`Loading ${KIN_DEALS.title}`} />
              ) : notRead !== null ? (
                <EmptyState variant="plain" {...notRead} />
              ) : state._tag === "failed" ? (
                <KinLoadFailed title={KIN_DEALS.loadFailed} cause={state.cause} onRetry={refresh} />
              ) : (result?.deals.length ?? 0) > 0 ? (
                <EmptyState
                  variant="plain"
                  title={`Nothing matches “${text.trim()}”`}
                  detail="Try another word."
                />
              ) : (
                <EmptyState
                  variant="card"
                  title={nothing.title}
                  detail={nothing.detail}
                  {...(add === null || filter.state !== "open"
                    ? {}
                    : {
                        action: (
                          <Button
                            tone="primary"
                            icon="plus"
                            label={KIN_DEALS.newDeal}
                            onPress={add}
                          />
                        ),
                      })}
                />
              )}
            </View>
          }
          ListFooterComponent={
            result === null ? null : (
              <>
                {result.more === 0 ? null : (
                  <Text textRole="footnote" className="px-5 py-4 text-foreground-muted">
                    {KIN_DEALS.more(result.more)}
                  </Text>
                )}
                {result.numbers === undefined ? null : (
                  <DealNumbers numbers={result.numbers} names={names} onFilter={setFilter} />
                )}
                <WhatWeHear concerns={result.concerns} />
              </>
            )
          }
          renderItem={({ item }) =>
            item.type === "stage" ? (
              <View
                accessible
                accessibilityRole="header"
                accessibilityLabel={[item.name, KIN_DEALS.dealCount(item.count), item.total]
                  .filter((part) => part !== "")
                  .join(", ")}
                className="flex-row items-baseline gap-2 px-5 pt-5 pb-1"
              >
                <Text textRole="footnote" className="font-t3-medium text-foreground">
                  {item.name}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {item.count}
                </Text>
                <Text textRole="footnote" className="ml-auto text-foreground-muted tabular-nums">
                  {item.total}
                </Text>
              </View>
            ) : (
              <KinDealRowButton
                row={item.row}
                note={item.note}
                onPress={() => open(item.row.key)}
              />
            )
          }
        />
      </ScreenContent>
    </View>
  );
}

/** Won this month and this week, under Open: Kin's counts, nothing until a deal exists. */
function DealFigures(props: { readonly numbers: KinDealNumbers | undefined }) {
  const figures = kinDealFigures(props.numbers);
  if (figures === null) return null;
  return (
    <>
      <View
        accessible
        accessibilityLabel={[
          `${figures.won.label}: ${figures.won.count}`,
          ...figures.won.values,
        ].join(". ")}
        className="gap-0.5 bg-grouped-card px-4 py-3"
      >
        <Text textRole="footnote" className="text-foreground-muted">
          {figures.won.label}
        </Text>
        {figures.won.values.map((line) => (
          <Text
            key={line}
            textRole="headline"
            className="font-t3-medium text-foreground tabular-nums"
          >
            {line}
          </Text>
        ))}
        <Text textRole="footnote" className="text-foreground-muted">
          {figures.won.count}
        </Text>
      </View>
      {figures.week === null ? null : (
        <View
          accessible
          accessibilityLabel={`${KIN_DEAL_NUMBERS.thisWeek}: ${figures.week}`}
          className="gap-0.5 bg-grouped-card px-4 py-3"
        >
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_DEAL_NUMBERS.thisWeek}
          </Text>
          <Text textRole="headline" className="font-t3-medium text-foreground tabular-nums">
            {figures.week}
          </Text>
        </View>
      )}
    </>
  );
}

/**
 * The figures' sections, folded as the page's others: this week in deals, each person's (only
 * their own for a sales person), and the owner level's month. A person's row opens their open
 * deals through the list's own filter.
 */
function DealNumbers(props: {
  readonly numbers: KinDealNumbers;
  readonly names: KinWorkNames;
  readonly onFilter: (filter: KinDealsFilter) => void;
}) {
  const figures = kinDealFigures(props.numbers);
  const groups = kinDealWeekGroups(props.numbers, props.names);
  const people = kinDealPeopleRows(props.numbers, props.names);
  const month = kinDealMonthRows(props.numbers);
  return (
    <View className="gap-3 px-4 pt-5">
      {groups.length === 0 ? null : (
        <KinFoldSection title={KIN_DEAL_NUMBERS.thisWeekInDeals} summary={figures?.week ?? null}>
          <ListRowLayout label={KIN_DEAL_NUMBERS.since(props.numbers.weekStart)} disabled />
          {groups.flatMap((group) => [
            <ListRowLayout key={group.id} label={group.title} disabled />,
            ...group.rows.map((row) => (
              <ListRowLayout
                key={`${group.id}:${row.key}`}
                label={row.title}
                {...(row.line === null ? {} : { description: row.line })}
                {...(row.value === null ? {} : { detail: row.value })}
              />
            )),
            ...(group.more === 0
              ? []
              : [
                  <ListRowLayout
                    key={`${group.id}:more`}
                    label={KIN_DEAL_NUMBERS.more(group.more)}
                    disabled
                  />,
                ]),
          ])}
        </KinFoldSection>
      )}
      {people.length === 0 ? null : (
        // Only the owner level is sent the rate, and everyone's rows with it.
        <KinFoldSection
          title={
            props.numbers.winRate === undefined ? KIN_DEAL_NUMBERS.yours : KIN_DEAL_NUMBERS.byPerson
          }
          summary={null}
        >
          {people.map((row) => {
            const filter = row.filter;
            const content = {
              label: row.name,
              description: `${KIN_DEAL_NUMBERS.wonThisMonth}: ${row.won.join(" · ")} · ${KIN_DEAL_NUMBERS.lateFollowUps}: ${row.late}`,
              detail: row.open.join(" · "),
            };
            return filter === null || row.openCount === 0 ? (
              <ListRowLayout key={row.id} {...content} />
            ) : (
              <ListRow key={row.id} {...content} onPress={() => props.onFilter(filter)} />
            );
          })}
        </KinFoldSection>
      )}
      {month.rows.length <= 1 ? null : (
        <KinFoldSection title={KIN_DEAL_NUMBERS.month} summary={null}>
          {month.rows.map((row) => (
            <ListRowLayout key={row.label} label={row.label} detail={row.value} />
          ))}
          {month.sources.length === 0
            ? null
            : [
                <ListRowLayout key="sources" label={KIN_DEAL_NUMBERS.sources} disabled />,
                ...month.sources.map((row) => (
                  <ListRowLayout key={`source:${row.label}`} label={row.label} detail={row.value} />
                )),
              ]}
        </KinFoldSection>
      )}
    </View>
  );
}

/** The concerns raised on the deals shown, counted by Kin; nothing at all until one is raised. */
function WhatWeHear(props: { readonly concerns: KinDealsResult["concerns"] }) {
  const rows = kinDealConcernRows(props.concerns);
  if (rows.length === 0) return null;
  return (
    <View className="gap-2 px-4 pt-5">
      <ListSection title={KIN_DEALS.whatWeHear}>
        {rows.map((row) => (
          <ListRowLayout
            key={row.label}
            label={row.label}
            description={row.stands}
            detail={row.deals}
          />
        ))}
      </ListSection>
      <Text textRole="footnote" className="px-1 text-foreground-muted">
        {KIN_DEALS.whatWeHearHint}
      </Text>
    </View>
  );
}

/** A client's page: its deals, open first, with New deal. */
export function KinClientDeals(
  props: KinWorkTarget & {
    readonly party: { readonly key: KinRecordKey; readonly title: string };
    readonly closed: boolean;
    readonly names: KinWorkNames;
  },
) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const { environmentId, orgId, party } = props;
  const { state } = useKinDeals(props, { orgId, party: party.key });
  const now = new Date(useNowMinuteMs());
  if (state._tag !== "ready") return null;
  const section = kinDealsSection(state.value.deals, props.names, now, party.key);
  return (
    <ListSection title={KIN_DEALS.section}>
      {section.rows.length === 0 ? (
        <ListRowLayout label={KIN_DEALS.sectionNone} disabled />
      ) : (
        section.rows.map((row) => (
          <KinDealRowButton
            key={row.key}
            inset
            row={row}
            pill={row.pill}
            onPress={() => openRecord("KinDeal", { environmentId, orgId, deal: row.key })}
          />
        ))
      )}
      {section.more === 0 ? null : <ListRowLayout label={`${section.more} more`} disabled />}
      {state.value.canCreate && !props.closed ? (
        <ListActionRow
          icon="plus"
          label={KIN_DEALS.newDeal}
          onPress={() =>
            navigation.navigate("KinDealNew", {
              environmentId,
              orgId,
              party: party.key,
              partyName: party.title,
            })
          }
        />
      ) : null}
    </ListSection>
  );
}
