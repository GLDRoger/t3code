import { useNavigation } from "@react-navigation/native";
import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import {
  KIN_DATES,
  kinDateRowView,
  type KinDateRowView,
} from "@t3tools/client-runtime/kin/kinDates";
import { KIN_LISTS, kinListsIndex } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_MONEY,
  kinMoneyHeadline,
  kinMoneyView,
  type KinListOpen,
  type KinMoneyFigure,
} from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_WORK_TITLE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useKinTab } from "./components/KinTab";
import {
  KinWorkAreaSwitch,
  KinWorkLoading,
  KinWorkStaleNotice,
  type KinWorkAreas,
} from "./components/KinWorkPieces";
import { kinListsOf, useKinAskAgent, useKinLists, useKinMoneySummary } from "./state/useKinMoney";
import { refreshKinWorkLive, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";
import { KinChart } from "./widgets/KinChart";

type Shared = KinWorkTarget & {
  readonly live: KinWorkLive;
  readonly stale: boolean;
  readonly directory: KinWorkDirectory;
  readonly areas: KinWorkAreas;
};

/** Where a figure's entries open: the list, narrowed to them. */
export function useKinOpenList(target: KinWorkTarget) {
  const navigation = useNavigation();
  return (open: KinListOpen) =>
    navigation.navigate("KinList", {
      ...target,
      list: open.list,
      filter: JSON.stringify(open.filter),
    });
}

/** One part of Work that isn't a paged list: the switch, then whatever the part shows. */
function AreaFrame(props: {
  readonly target: KinWorkTarget;
  readonly areas: KinWorkAreas;
  readonly stale: boolean;
  readonly onRefresh: () => void;
  readonly children: React.ReactNode;
}) {
  const navigation = useNavigation();
  const tab = useKinTab();
  // The counts may be what failed, so they are read again with the area's own figures.
  const refresh = () => {
    refreshKinWorkLive(props.target);
    props.onRefresh();
  };
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_WORK_TITLE}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        {...(tab === null ? { onBack: () => navigation.goBack() } : {})}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            paddingTop: 8,
            paddingBottom: 32 + (tab?.bottomClearance ?? 0),
            gap: 20,
          }}
        >
          <KinWorkAreaSwitch {...props.areas} />
          {props.stale ? (
            <View className="px-4">
              <KinWorkStaleNotice environmentId={props.target.environmentId} onRetry={refresh} />
            </View>
          ) : null}
          <View className="gap-6 px-4">{props.children}</View>
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** One figure, a line per currency. It opens the entries it was added up from. */
function Figure(props: {
  readonly figure: KinMoneyFigure;
  readonly onOpen: (open: KinListOpen) => void;
}) {
  const { figure } = props;
  const { open } = figure;
  return (
    <Pressable
      accessibilityRole={open === null ? "text" : "button"}
      accessibilityLabel={[figure.label, figure.lines.join(" and "), figure.note]
        .filter((part) => part !== null)
        .join(". ")}
      {...(open === null ? {} : { accessibilityHint: "Shows the entries" })}
      disabled={open === null}
      onPress={() => (open === null ? undefined : props.onOpen(open))}
      className="min-h-11 min-w-0 flex-1 gap-0.5 active:opacity-60"
    >
      <Text textRole="footnote" className="text-foreground-muted">
        {figure.label}
      </Text>
      {figure.lines.map((line) => (
        <Text
          key={line}
          textRole="title"
          selectable
          className={cn(
            "font-t3-bold tabular-nums",
            figure.late ? "text-danger-foreground" : "text-foreground",
          )}
        >
          {line}
        </Text>
      ))}
      {figure.note === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {figure.note}
        </Text>
      )}
    </Pressable>
  );
}

/** A name on the left and its exact amounts on the right; it opens what it counts. */
function AmountRow(props: {
  readonly label: string;
  readonly note?: string | null;
  readonly late?: boolean;
  readonly amounts: ReadonlyArray<string>;
  readonly onOpen: (() => void) | null;
}) {
  const { onOpen } = props;
  return (
    <Pressable
      accessibilityRole={onOpen === null ? "text" : "button"}
      accessibilityLabel={[props.label, props.amounts.join(" and "), props.note ?? null]
        .filter((part) => part !== null)
        .join(". ")}
      disabled={onOpen === null}
      onPress={() => onOpen?.()}
      className="min-h-11 flex-row items-center gap-3 bg-grouped-card px-4 py-2.5 active:opacity-60"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" numberOfLines={1} className="text-foreground">
          {props.label}
        </Text>
        {props.note == null ? null : (
          <Text
            textRole="footnote"
            numberOfLines={1}
            className={props.late ? "text-danger-foreground" : "text-foreground-muted"}
          >
            {props.note}
          </Text>
        )}
      </View>
      <View className="items-end">
        {props.amounts.map((amount) => (
          <Text key={amount} textRole="body" className="tabular-nums text-foreground">
            {amount}
          </Text>
        ))}
      </View>
    </Pressable>
  );
}

/** Something with a date, whatever list it is in. */
export function KinDateRowLine(props: {
  readonly row: KinDateRowView;
  /** Says the day on the row, where no heading above it does. */
  readonly dated?: boolean;
  readonly onPress: () => void;
}) {
  const { row } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.accessibilityLabel}
      onPress={props.onPress}
      className="min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-2.5 active:opacity-60"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          textRole="body"
          numberOfLines={2}
          className={row.closed ? "text-foreground-muted" : "text-foreground"}
        >
          {row.title}
        </Text>
        <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
          {[props.dated ? row.when : null, row.time, row.line]
            .filter((part) => part !== null)
            .join(" · ")}
        </Text>
      </View>
      <View className="items-end gap-0.5">
        {row.amount === null ? null : (
          <Text textRole="body" className="tabular-nums text-foreground">
            {row.amount}
          </Text>
        )}
        {row.late ? (
          <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
            {KIN_DATES.overdue}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function Heading(props: { readonly children: string }) {
  return (
    <Text textRole="headline" accessibilityRole="header" className="text-foreground">
      {props.children}
    </Text>
  );
}

/** Money: who owes us, what came in and went out, the year so far, and what is coming up. */
export function KinMoneyArea(props: Shared) {
  const navigation = useNavigation();
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const seq = props.stale ? null : props.live.seq;
  const money = useKinMoneySummary(target, { enabled: true, seq });
  const lists = useKinLists(target, { enabled: true, seq });
  const agent = useKinAskAgent(target);
  const openList = useKinOpenList(target);
  const now = new Date(useNowMinuteMs());
  const { names } = props.directory;
  const { state } = money;
  const frame = {
    target,
    areas: props.areas,
    stale: props.stale,
    onRefresh: () => {
      money.refresh();
      lists.refresh();
    },
  };
  if (state._tag !== "ready") {
    return (
      <AreaFrame {...frame}>
        {state._tag === "loading" ? (
          <KinWorkLoading label="Loading Money" />
        ) : state._tag === "refused" ? (
          <EmptyState variant="plain" {...KIN_MONEY.onlyOwner} />
        ) : (
          <EmptyState
            variant="plain"
            title={KIN_MONEY.loadFailed}
            detail="Check your connection to the server and try again."
            action={<Button tone="secondary" label="Try again" onPress={money.refresh} />}
          />
        )}
      </AreaFrame>
    );
  }
  const summary = state.value;
  const view = kinMoneyView(summary, kinListsOf(lists));
  if (view.empty) {
    return (
      <AreaFrame {...frame}>
        <EmptyState
          variant="plain"
          {...KIN_MONEY.none}
          {...(agent === null
            ? {}
            : {
                action: (
                  <Button
                    tone="primary"
                    icon="bubble.left"
                    label={KIN_MONEY.ask}
                    onPress={() => agent.ask(KIN_MONEY.askMessage)}
                  />
                ),
              })}
        />
      </AreaFrame>
    );
  }
  const upcoming = summary.upcoming.map((row) => kinDateRowView(row, names, now));
  const openEntry = (task: string) => navigation.navigate("KinWorkItem", { ...target, task });
  return (
    <AreaFrame {...frame}>
      <View className="gap-4">
        <View className="flex-row gap-4 px-2">
          <Figure figure={view.owed} onOpen={openList} />
          <Figure figure={view.overdue} onOpen={openList} />
        </View>
        <ListSection title={KIN_MONEY.byClient}>
          {view.clients.length === 0 ? (
            <Text textRole="body" className="px-4 py-3 text-foreground-muted">
              {KIN_MONEY.nothingOwed}
            </Text>
          ) : (
            view.clients.map((client) => {
              const { open } = client;
              return (
                <AmountRow
                  key={client.key}
                  label={client.name}
                  note={client.overdue ?? client.invoices}
                  late={client.overdue !== null}
                  amounts={client.owed}
                  onOpen={open === null ? null : () => openList(open)}
                />
              );
            })
          )}
        </ListSection>
      </View>
      <View className="gap-4">
        <View className="px-2">
          <Heading>{view.monthLabel}</Heading>
        </View>
        <View className="flex-row gap-4 px-2">
          <Figure figure={view.received} onOpen={openList} />
          <Figure figure={view.spent} onOpen={openList} />
        </View>
        {view.categories.length === 0 ? null : (
          <ListSection title={KIN_MONEY.byCategory}>
            {view.categories.map((category) => {
              const { open } = category;
              return (
                <AmountRow
                  key={category.key}
                  label={category.label}
                  amounts={[category.amount]}
                  onOpen={open === null ? null : () => openList(open)}
                />
              );
            })}
          </ListSection>
        )}
      </View>
      <View className="gap-4">
        <View className="px-2">
          <Heading>{view.yearLabel}</Heading>
        </View>
        <View className="flex-row gap-4 px-2">
          <Figure figure={view.yearReceived} onOpen={openList} />
          <Figure figure={view.yearSpent} onOpen={openList} />
        </View>
      </View>
      {view.charts.map((chart) => (
        <View key={chart.unit.kind === "money" ? chart.unit.currency : ""} className="px-2">
          <KinChart view={kinChartView(chart)} />
        </View>
      ))}
      {view.charts.length === 0 ? null : (
        <ListSection title={KIN_MONEY.months}>
          {view.months.map((month) => {
            const received = month.openReceived;
            const spent = month.openSpent;
            return (
              <View key={month.month} className="gap-1 bg-grouped-card px-4 py-2.5">
                <Text textRole="footnote" className="text-foreground-muted">
                  {month.label}
                </Text>
                <View className="flex-row gap-4">
                  <MonthFigure
                    label={KIN_MONEY.received}
                    amount={month.received}
                    onOpen={received === null ? null : () => openList(received)}
                  />
                  <MonthFigure
                    label={KIN_MONEY.spent}
                    amount={month.spent}
                    onOpen={spent === null ? null : () => openList(spent)}
                  />
                </View>
              </View>
            );
          })}
        </ListSection>
      )}
      <ListSection title={KIN_MONEY.upcoming}>
        {upcoming.length === 0 ? (
          <Text textRole="body" className="px-4 py-3 text-foreground-muted">
            {KIN_MONEY.nothingUpcoming}
          </Text>
        ) : (
          upcoming.map((row) => (
            <KinDateRowLine key={row.id} row={row} dated onPress={() => openEntry(row.key)} />
          ))
        )}
        <ListActionRow
          label={KIN_MONEY.allDates}
          onPress={() => navigation.navigate("KinDates", target)}
        />
      </ListSection>
      {agent === null ? null : (
        <Button
          tone="secondary"
          icon="bubble.left"
          label={`Ask ${agent.name}`}
          onPress={() => agent.ask("")}
        />
      )}
    </AreaFrame>
  );
}

function MonthFigure(props: {
  readonly label: string;
  readonly amount: string;
  readonly onOpen: (() => void) | null;
}) {
  const { onOpen } = props;
  return (
    <Pressable
      accessibilityRole={onOpen === null ? "text" : "button"}
      accessibilityLabel={`${props.label}: ${props.amount}`}
      disabled={onOpen === null}
      onPress={() => onOpen?.()}
      className="min-h-11 min-w-0 flex-1 justify-center active:opacity-60"
    >
      <Text textRole="footnote" className="text-foreground-muted">
        {props.label}
      </Text>
      <Text textRole="body" className="tabular-nums text-foreground">
        {props.amount}
      </Text>
    </Pressable>
  );
}

/** Every list an agent set up, and the one view across all their dates. */
export function KinListsArea(props: Shared) {
  const navigation = useNavigation();
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const seq = props.stale ? null : props.live.seq;
  const [archived, setArchived] = useState(false);
  const lists = useKinLists(target, { enabled: true, archived, seq });
  const agent = useKinAskAgent(target);
  const { state } = lists;
  const frame = { target, areas: props.areas, stale: props.stale, onRefresh: lists.refresh };
  if (state._tag !== "ready") {
    return (
      <AreaFrame {...frame}>
        {state._tag === "loading" ? (
          <KinWorkLoading label="Loading lists" />
        ) : state._tag === "refused" ? (
          <EmptyState variant="plain" {...KIN_LISTS.onlyOwner} />
        ) : (
          <EmptyState
            variant="plain"
            title={KIN_LISTS.loadFailed}
            detail="Check your connection to the server and try again."
            action={<Button tone="secondary" label="Try again" onPress={lists.refresh} />}
          />
        )}
      </AreaFrame>
    );
  }
  const index = kinListsIndex(state.value.lists);
  const ask =
    agent === null ? null : (
      <Button
        tone={index.active.length === 0 ? "primary" : "secondary"}
        icon="bubble.left"
        label={KIN_LISTS.ask}
        onPress={() => agent.ask(KIN_LISTS.askMessage)}
      />
    );
  const open = (list: string) => navigation.navigate("KinList", { ...target, list });
  return (
    <AreaFrame {...frame}>
      <ListSection>
        <ListRow
          icon="calendar.badge.clock"
          label={KIN_DATES.title}
          description={KIN_DATES.summary}
          onPress={() => navigation.navigate("KinDates", target)}
        />
      </ListSection>
      {index.active.length === 0 && index.archived.length === 0 ? (
        <EmptyState
          variant="plain"
          {...KIN_LISTS.none}
          {...(ask === null ? {} : { action: ask })}
        />
      ) : (
        <>
          <ListSection title={KIN_LISTS.title}>
            {index.active.map((row) => (
              <ListRow
                key={row.list}
                label={row.name}
                detail={row.line}
                onPress={() => open(row.list)}
              />
            ))}
          </ListSection>
          {archived && index.archived.length > 0 ? (
            <ListSection title={KIN_LISTS.archived}>
              {index.archived.map((row) => (
                <ListRow
                  key={row.list}
                  label={row.name}
                  detail={row.line}
                  onPress={() => open(row.list)}
                />
              ))}
            </ListSection>
          ) : null}
          <ListSection>
            <ListToggleRow
              label={KIN_LISTS.showArchived}
              value={archived}
              onValueChange={setArchived}
            />
          </ListSection>
          {ask}
        </>
      )}
    </AreaFrame>
  );
}

/** Work's task list opens with what is owed and what moved this month; it leads to Money. */
export function KinMoneyHeadlineRow(
  props: KinWorkTarget & { readonly seq: number | null; readonly onOpen: () => void },
) {
  const money = useKinMoneySummary(props, { enabled: true, seq: props.seq });
  if (money.state._tag !== "ready") return null;
  const lines = kinMoneyHeadline(money.state.value);
  if (lines.length === 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${KIN_MONEY.title}. ${lines.join(". ")}`}
      accessibilityHint="Opens Money"
      onPress={props.onOpen}
      className="mx-4 min-h-11 flex-row items-center gap-3 rounded-2xl bg-grouped-card px-4 py-3 active:opacity-60"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        {lines.map((line) => (
          <Text key={line} textRole="footnote" className="tabular-nums text-foreground">
            {line}
          </Text>
        ))}
      </View>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}
