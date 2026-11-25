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
  kinDealsMatching,
  kinDealsCount,
  kinDealsQuery,
  kinDealsNothing,
  kinDealsNotRead,
  kinDealsSection,
  type KinDealNextView,
  type KinDealRowView,
  type KinDealsFilter,
  type KinDealsWho,
} from "@t3tools/client-runtime/kin/kinDeals";
import { KIN_WORK_HOME } from "@t3tools/client-runtime/kin/kinWorkHome";
import {
  KIN_CLIENTS,
  kinClientsChosenKey,
  kinMineChoices,
  kinMineChosenAtom,
  kinMineOpens,
  type KinMineSide,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type {
  KinDealNumbers,
  KinDealState,
  KinDealsResult,
  KinPersonId,
  KinRecordKey,
} from "@t3tools/contracts";
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
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
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
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";
import { useKinSectionNamed } from "./state/useKinShell";

const TONE: Record<KinDealNextView["tone"], string> = {
  plain: "text-foreground-muted",
  missing: "text-warning-foreground",
  late: "text-danger-foreground",
};

/** A deal's next step, or that it has none (amber), or that it is late (red). */
export function KinDealNextLine(props: { readonly next: KinDealNextView | null }) {
  const grows = useKinTextGrows();
  if (props.next === null) return null;
  return (
    <Text textRole="footnote" numberOfLines={kinLines(1, grows)} className={TONE[props.next.tone]}>
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
  const grows = useKinTextGrows();
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
            <Text
              textRole="body"
              numberOfLines={kinLines(2, grows)}
              className="min-w-0 shrink text-foreground"
            >
              {row.title}
            </Text>
            {row.private ? <KinWorkPrivateMark label="" /> : null}
          </View>
          {row.line === "" ? null : (
            <Text
              textRole="footnote"
              numberOfLines={kinLines(1, grows)}
              className="text-foreground-muted"
            >
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

/** Which deals, as the bar's one Show menu; whose is the switch on the tab. */
function dealsMenu(filter: KinDealsFilter, onFilter: (filter: KinDealsFilter) => void): AppBarMenu {
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
    ],
  };
}

/**
 * Above a list and outside its scroll, so what it holds stays while the rows move. On iOS it
 * clears the bar the rows otherwise slide under.
 */
export function KinListPinned(props: { readonly children: React.ReactNode }) {
  const bar = useBarOverlap();
  return (
    <View className="gap-2 bg-screen px-4 pb-2" style={{ paddingTop: bar + 8 }}>
      {props.children}
    </View>
  );
}

/** Mine / Everyone on the list's tab itself, each side with its count once read. */
export function KinMineSwitch(props: {
  readonly side: KinMineSide;
  readonly counts: Parameters<typeof kinMineChoices>[0];
  readonly onSelect: (side: KinMineSide) => void;
}) {
  return (
    <SegmentedControl
      options={kinMineChoices(props.counts)}
      selected={props.side}
      onSelect={props.onSelect}
      role="tab"
    />
  );
}

/** The Deals tab on the phone: open deals under each stage, won and lost under Show. */
export function KinDealsView(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly stale: boolean;
    /** Which of Clients, Deals and Projects shows. */
    readonly header: React.ReactNode;
    readonly ask: AppBarAction | null;
  },
) {
  const clientsTitle = useKinSectionNamed(props.environmentId)(KIN_CLIENTS.title);
  const navigation = useNavigation();
  const tab = useKinTab();
  const { environmentId, orgId } = props;
  const { names } = props.directory;
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  // Until the host says who this is nothing is read, and nothing says "Mine" on a guess.
  const start = useKinDealsStart(environmentId);
  const [which, setWhich] = useState<KinDealState>("open");
  // A person's row under the figures opens their deals; the switch is back once it's cleared.
  const [person, setPerson] = useState<KinPersonId | null>(null);
  const remembered = kinMineChosenAtom(kinClientsChosenKey(environmentId, names.me));
  const [asked, setAsked] = useState<KinMineSide | null>(null);
  const ask = (who: KinDealsWho, at: KinDealState) =>
    start === null ? null : kinDealsQuery(orgId, { who, state: at }, start, names.me);
  const mine = useKinDeals(props, ask({ _tag: "me" }, which)?.input ?? null);
  const everyone = useKinDeals(props, ask({ _tag: "everyone" }, which)?.input ?? null);
  const theirs = useKinDeals(
    props,
    person === null ? null : (ask({ _tag: "person", personId: person }, which)?.input ?? null),
  );
  const countOf = (read: typeof mine) =>
    read.state._tag === "ready" ? kinDealsCount(read.state.value, which) : null;
  const counts = {
    // Someone the host knows but who has no person id here has nothing of their own.
    mine: countOf(mine) ?? (start !== null && names.me === null ? { n: 0 } : null),
    everyone: countOf(everyone),
  };
  // A Mine that can't be read opens nothing of its own: the board opens on Everyone.
  const side =
    asked ??
    kinMineOpens(
      appAtomRegistry.get(remembered).deals ?? null,
      counts.mine ?? (mine.state._tag === "loading" ? null : { n: 0 }),
    );
  const choose = (next: KinMineSide) => {
    appAtomRegistry.set(remembered, { ...appAtomRegistry.get(remembered), deals: next });
    setPerson(null);
    setAsked(next);
  };
  const filter: KinDealsFilter = {
    who:
      person !== null
        ? { _tag: "person", personId: person }
        : side === "mine"
          ? { _tag: "me" }
          : { _tag: "everyone" },
    state: which,
  };
  const shownRead = person !== null ? theirs : side === "mine" ? mine : everyone;
  const setFilter = (next: KinDealsFilter) => {
    setWhich(next.state);
    if (next.who._tag === "person") setPerson(next.who.personId);
    else if (next.who._tag === "me") choose("mine");
    else if (next.who._tag === "everyone" && person !== null) setPerson(null);
  };
  const [text, setText] = useState("");
  // Mine's count decides the side; until it is read the board shows it is loading.
  const dealsState = side === null ? ({ _tag: "loading" } as const) : shownRead.state;
  const refresh = () => {
    mine.refresh();
    everyone.refresh();
    theirs.refresh();
  };
  const notRead = kinDealsNotRead(dealsState);
  const rates = useKinRates(props, ownerLevel);
  const now = new Date(useNowMinuteMs());
  const result = dealsState._tag === "ready" ? dealsState.value : null;
  const deals = kinDealsMatching(result?.deals ?? [], text);
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
  const personChip =
    person === null ? null : KIN_DEALS.personChip(names.people.get(person) ?? KIN_DEALS.someone);
  const owner = person ?? (side === "mine" ? names.me : null);

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        // The place's own name, as on its Clients and Projects tabs.
        title={clientsTitle}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        actions={[
          ...(props.ask === null ? [] : [props.ask]),
          ...(add === null
            ? []
            : [{ accessibilityLabel: KIN_DEALS.newDeal, icon: "plus" as const, onPress: add }]),
        ]}
        menus={[dealsMenu(filter, setFilter)]}
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
        <KinListPinned>
          {props.header}
          {personChip === null ? (
            side === null ? null : (
              <KinMineSwitch side={side} counts={counts} onSelect={choose} />
            )
          ) : (
            <View className="flex-row">
              <Chip
                selected
                icon="xmark"
                label={personChip}
                accessibilityLabel={`${personChip}. ${KIN_DEALS.clearPerson}`}
                onPress={() => setPerson(null)}
              />
            </View>
          )}
        </KinListPinned>
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
          extraData={dealsState}
          estimatedItemSize={80}
          recycleItems
          ListHeaderComponent={
            <View className="gap-3 px-4 pt-2">
              {props.stale || (dealsState._tag === "ready" && dealsState.stale) ? (
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
            </View>
          }
          ListEmptyComponent={
            <View className="px-4 pt-4">
              {dealsState._tag === "loading" ? (
                <KinWorkLoading label={`Loading ${KIN_DEALS.title}`} />
              ) : notRead !== null ? (
                <EmptyState variant="plain" {...notRead} />
              ) : dealsState._tag === "failed" ? (
                <KinLoadFailed
                  title={KIN_DEALS.loadFailed}
                  cause={dealsState.cause}
                  onRetry={refresh}
                />
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
                <WhatWeHear
                  concerns={result.concerns}
                  onOpen={(concern) =>
                    navigation.navigate("KinDealsConcern", {
                      environmentId,
                      orgId,
                      concern,
                      ...(owner === null ? {} : { owner }),
                    })
                  }
                />
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
function WhatWeHear(props: {
  readonly concerns: KinDealsResult["concerns"];
  readonly onOpen: (label: string) => void;
}) {
  const rows = kinDealConcernRows(props.concerns);
  if (rows.length === 0) return null;
  return (
    <View className="gap-2 px-4 pt-5">
      <ListSection title={KIN_DEALS.whatWeHear}>
        {rows.map((row) => (
          <ListRow
            key={row.label}
            label={row.label}
            description={row.stands}
            detail={row.deals}
            onPress={() => props.onOpen(row.label)}
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
