import { useNavigation } from "@react-navigation/native";
import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import {
  KIN_DATES,
  kinDateRowView,
  type KinDateRowView,
} from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_MONEY,
  kinMoneyView,
  type KinListOpen,
  type KinMoneyFigure,
} from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_WORK_HOME, kinWorkAskDraft } from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CURRENCY,
  kinEstimatesByLine,
  kinMissingRates,
  kinRateLine,
  kinTotalsEstimate,
  type KinEstimate,
} from "@t3tools/client-runtime/kin/kinCurrency";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { KinReceiptsSection } from "./KinInvoice";
import { KinEstimateText, KinSetRateLink } from "./KinMoneyEstimate";
import { KinSubscriptionsSection } from "./KinSubscriptions";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useKinTab } from "./components/KinTab";
import { KinWorkLoading, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import {
  kinListsOf,
  useKinAskAgent,
  useKinLists,
  useKinMoneySummary,
  useKinRates,
} from "./state/useKinMoney";
import { refreshKinWorkLive, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";
import { KinChart } from "./widgets/KinChart";

type Shared = KinWorkTarget & {
  readonly live: KinWorkLive;
  readonly stale: boolean;
  readonly directory: KinWorkDirectory;
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

/** Money's page, with its ways to add and to hand over to an agent in the bar. */
function AreaFrame(props: {
  readonly target: KinWorkTarget;
  readonly stale: boolean;
  readonly onRefresh: () => void;
  readonly children: React.ReactNode;
}) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const agent = useKinAskAgent(props.target, "money");
  const canReceipt = useAtomValue(kinClient.makeReceipt.permissionAtom(props.target.environmentId));
  const base = {
    environmentId: String(props.target.environmentId),
    orgId: String(props.target.orgId),
  };
  const addItems: ReadonlyArray<AppBarMenuItem> = [
    ...(agent === null
      ? []
      : [
          {
            id: "expense",
            title: KIN_WORK_HOME.addExpense,
            subtitle: `${agent.name} logs it`,
            icon: "tag" as const,
            onPress: () => agent.ask("Log an expense: "),
          },
        ]),
    ...(canReceipt
      ? [
          {
            id: "receipt",
            title: KIN_WORK_HOME.addReceipt,
            icon: "doc.text" as const,
            onPress: () => navigation.navigate("KinReceiptNew", base),
          },
        ]
      : []),
  ];
  // The counts may be what failed, so they are read again with the area's own figures.
  const refresh = () => {
    refreshKinWorkLive(props.target);
    props.onRefresh();
  };
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_WORK_HOME.places.money}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        {...(tab === null ? { onBack: () => navigation.goBack() } : {})}
        {...(agent === null
          ? {}
          : {
              actions: [
                {
                  accessibilityLabel: `Ask ${agent.name}`,
                  icon: "bubble.left",
                  onPress: () => agent.ask(kinWorkAskDraft("money")),
                },
              ],
            })}
        {...(addItems.length === 0
          ? {}
          : { menus: [{ title: KIN_WORK_HOME.add, icon: "plus", items: addItems }] })}
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
  /** Each foreign line's "about ₹x", by line. */
  readonly estimates?: ReadonlyMap<string, KinEstimate>;
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
      {figure.lines.map((line) => {
        const estimate = props.estimates?.get(line);
        return (
          <View key={line}>
            <Text
              textRole="title"
              selectable
              className={cn(
                "font-t3-bold tabular-nums",
                figure.late ? "text-danger-foreground" : "text-foreground",
              )}
            >
              {line}
            </Text>
            {estimate === undefined ? null : (
              <KinEstimateText text={estimate.text} basis={estimate.basis} />
            )}
          </View>
        );
      })}
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
  readonly estimates?: ReadonlyMap<string, KinEstimate>;
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
        {props.amounts.map((amount) => {
          const estimate = props.estimates?.get(amount);
          return (
            <View key={amount} className="items-end">
              <Text textRole="body" className="tabular-nums text-foreground">
                {amount}
              </Text>
              {estimate === undefined ? null : (
                <Text textRole="footnote" className="tabular-nums text-foreground-muted">
                  {estimate.text}
                </Text>
              )}
            </View>
          );
        })}
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
  const rates = useKinRates(target);
  const openList = useKinOpenList(target);
  const now = new Date(useNowMinuteMs());
  const { names } = props.directory;
  const { state } = money;
  const frame = {
    target,
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
  // Every exact figure stays in its own currency; beside a foreign one, "about ₹x" when a rate is set.
  const estimates = kinEstimatesByLine(
    [
      ...summary.owed.total,
      ...summary.owed.overdue,
      ...summary.received.thisMonth,
      ...summary.received.lastMonth,
      ...summary.spent.thisMonth.total,
      ...summary.receivedThisFinancialYear,
      ...summary.spentThisFinancialYear,
      ...summary.owed.byClient.flatMap((client) => client.owed),
    ],
    rates,
  );
  const owedAll = kinTotalsEstimate(summary.owed.total, rates);
  const missing = kinMissingRates(
    [
      ...summary.owed.total,
      ...summary.spentThisFinancialYear,
      ...summary.receivedThisFinancialYear,
    ],
    rates,
  );
  const openEntry = (task: string) => navigation.navigate("KinWorkItem", { ...target, task });
  return (
    <AreaFrame {...frame}>
      <View className="gap-4">
        <View className="flex-row gap-4 px-2">
          <Figure figure={view.owed} onOpen={openList} estimates={estimates} />
          <Figure figure={view.overdue} onOpen={openList} estimates={estimates} />
        </View>
        {owedAll?.all == null && missing.length === 0 ? null : (
          <View className="gap-1 px-2">
            {owedAll?.all == null ? null : (
              <KinEstimateText
                text={`${owedAll.all} owed (estimate)`}
                basis={owedAll.basis.map((line) => `At ${line}.`)}
              />
            )}
            <KinSetRateLink {...target} currencies={missing} />
          </View>
        )}
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
                  estimates={estimates}
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
          <Figure figure={view.received} onOpen={openList} estimates={estimates} />
          <Figure figure={view.spent} onOpen={openList} estimates={estimates} />
        </View>
        {view.tdsDeducted === null ? null : (
          <View className="flex-row gap-4 px-2">
            <Figure figure={view.tdsDeducted} onOpen={openList} />
          </View>
        )}
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
      <KinSubscriptionsSection
        {...target}
        lists={kinListsOf(lists)}
        directory={props.directory}
        seq={seq}
        rates={rates}
      />
      <View className="gap-4">
        <View className="px-2">
          <Heading>{view.yearLabel}</Heading>
        </View>
        <View className="flex-row gap-4 px-2">
          <Figure figure={view.yearReceived} onOpen={openList} estimates={estimates} />
          <Figure figure={view.yearSpent} onOpen={openList} estimates={estimates} />
        </View>
        {view.yearTdsDeducted === null ? null : (
          <View className="flex-row gap-4 px-2">
            <Figure figure={view.yearTdsDeducted} onOpen={openList} />
          </View>
        )}
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
      <KinReceiptsSection {...target} seq={seq} />
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
      <ListSection title={KIN_CURRENCY.rates} footer={KIN_CURRENCY.ratesDetail}>
        <ListActionRow
          label={
            rates === null || rates.rates.length === 0
              ? KIN_CURRENCY.setRate
              : rates.rates.map((rate) => kinRateLine(rate, rates.home)).join("\n")
          }
          onPress={() =>
            navigation.navigate("KinRates", {
              environmentId: String(target.environmentId),
              orgId: String(target.orgId),
            })
          }
        />
      </ListSection>
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
