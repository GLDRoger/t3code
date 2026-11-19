import {
  kinNothingOwed,
  kinNothingShown,
  kinScopeNote,
} from "@t3tools/client-runtime/kin/kinViewerScope";
import { useNavigation } from "@react-navigation/native";
import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import {
  KIN_DATES,
  kinDatesAgenda,
  type KinDateRowView,
} from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_MONEY,
  kinMoneyView,
  type KinListOpen,
  type KinMoneyFigure,
} from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_GOALS, type KinAttentionOpen } from "@t3tools/client-runtime/kin/kinAttention";
import { KIN_BUDGETS, KIN_QUOTES } from "@t3tools/client-runtime/kin/kinMoneyAnswers";
import { KIN_SUBSCRIPTIONS } from "@t3tools/client-runtime/kin/kinSubscriptions";
import { KIN_WORK_HOME, kinWorkAskDraft } from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CURRENCY,
  kinEstimatesByLine,
  kinMissingRates,
  kinRateLine,
  kinOwedAbout,
  type KinEstimate,
} from "@t3tools/client-runtime/kin/kinCurrency";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { KinAttentionSection } from "./KinAttention";
import { KinGoals } from "./KinGoals";
import { KinReceiptsSection } from "./KinInvoice";
import { KinEstimateText, KinSetRateLink } from "./KinMoneyEstimate";
import {
  KinBudgetsSection,
  KinCashSection,
  KinOutlookSection,
  KinQuotesSection,
} from "./KinMoneyAnswers";
import { KinSubscriptionsSection } from "./KinSubscriptions";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { useKinTab } from "./components/KinTab";
import { KinFoldSection, KinWorkLoading, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { KinChooseCountry } from "./components/KinCountryFirst";
import { useKinIsOwnerLevel, useKinPlaceReach, useKinViewerScope } from "./state/kinChatOnly";
import {
  kinListsOf,
  useKinAskAgent,
  useKinCountryNeeded,
  useKinLists,
  useKinMoneySummary,
  useKinRates,
} from "./state/useKinMoney";
import { refreshKinWorkLive, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";
import { KinChart } from "./widgets/KinChart";
import { KinLoadFailed } from "./components/KinLoadFailed";

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
  /** False while the company's country is not chosen: nothing that records money is offered. */
  readonly adding?: boolean;
  readonly children: React.ReactNode;
}) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const agent = useKinAskAgent(props.target, "money");
  const canReceipt = useAtomValue(kinClient.makeReceipt.permissionAtom(props.target.environmentId));
  const canGoal = useAtomValue(kinClient.goalSave.permissionAtom(props.target.environmentId));
  const canBudget = useAtomValue(
    kinClient.workSetBudget.permissionAtom(props.target.environmentId),
  );
  const base = {
    environmentId: String(props.target.environmentId),
    orgId: String(props.target.orgId),
  };
  const offered: ReadonlyArray<AppBarMenuItem> = [
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
    ...(canBudget
      ? [
          {
            id: "budget",
            title: KIN_BUDGETS.add,
            icon: "gauge" as const,
            onPress: () => navigation.navigate("KinBudget", base),
          },
        ]
      : []),
    ...(canGoal
      ? [
          {
            id: "goal",
            title: KIN_GOALS.add,
            icon: "flag" as const,
            onPress: () => navigation.navigate("KinGoalForm", base),
          },
        ]
      : []),
    ...(agent === null
      ? []
      : [
          {
            id: "subscription",
            title: KIN_SUBSCRIPTIONS.add,
            subtitle: `${agent.name} keeps it`,
            icon: "arrow.clockwise" as const,
            onPress: () => agent.ask(KIN_SUBSCRIPTIONS.addMessage),
          },
          {
            id: "quote",
            title: KIN_MONEY.newQuote,
            subtitle: `${agent.name} drafts it`,
            icon: "doc.plaintext" as const,
            onPress: () => agent.ask(KIN_QUOTES.askMessage),
          },
        ]),
  ];
  const addItems = props.adding === false ? [] : offered;
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
        actions={[
          // Money has no list to filter, so its search finds anything, like the web's.
          {
            accessibilityLabel: KIN_WORK_HOME.search,
            icon: "magnifyingglass",
            onPress: () => navigation.navigate("KinSearch", base),
          },
          ...(agent === null
            ? []
            : [
                {
                  accessibilityLabel: `Ask ${agent.name}`,
                  icon: "bubble.left" as const,
                  onPress: () => agent.ask(kinWorkAskDraft("money")),
                },
              ]),
        ]}
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

/** Money: who owes us, what came in and went out, the year so far, and what is coming up. */
export function KinMoneyArea(props: Shared) {
  const navigation = useNavigation();
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const seq = props.stale ? null : props.live.seq;
  const datesAllowed = useAtomValue(kinClient.workDates.permissionAtom(target.environmentId));
  // Only a viewer who can't open Dates is drawn the coming-up rows themselves.
  const money = useKinMoneySummary(target, {
    enabled: true,
    use: datesAllowed ? "screen" : "rows",
  });
  const lists = useKinLists(target, { enabled: true, money: true });
  const agent = useKinAskAgent(target);
  const rates = useKinRates(target);
  const ratesAllowed = useAtomValue(kinClient.companyRead.permissionAtom(target.environmentId));
  const canAddLead = useAtomValue(kinClient.leadCreate.permissionAtom(target.environmentId));
  const now = new Date(useNowMinuteMs());
  const openList = useKinOpenList(target);
  const { names } = props.directory;
  const scope = useKinViewerScope(props.environmentId);
  const countryNeeded = useKinCountryNeeded(target);
  const ownerLevel = useKinIsOwnerLevel(props.environmentId);
  const reach = useKinPlaceReach(props.environmentId);
  const scopeNote = kinScopeNote("money", scope);
  const { state } = money;
  const frame = {
    target,
    stale: props.stale,
    onRefresh: () => {
      money.refresh();
      lists.refresh();
    },
  };
  // A teammate kept out of Money sees Money's own refusal, as before.
  if (countryNeeded && (ownerLevel || reach?.money === true)) {
    return (
      <AreaFrame {...frame} adding={false}>
        {ownerLevel ? (
          <EmptyState
            variant="plain"
            {...KIN_MONEY.countryFirst}
            action={<KinChooseCountry target={target} />}
          />
        ) : (
          <EmptyState variant="plain" {...KIN_MONEY.countryFirstMember} />
        )}
      </AreaFrame>
    );
  }
  if (state._tag !== "ready") {
    return (
      <AreaFrame {...frame}>
        {state._tag === "loading" ? (
          <KinWorkLoading label="Loading Money" />
        ) : state._tag === "refused" ? (
          <EmptyState variant="plain" {...KIN_MONEY.onlyOwner} />
        ) : (
          <KinLoadFailed
            title={KIN_MONEY.loadFailed}
            cause={state._tag === "failed" ? state.cause : null}
            onRetry={money.refresh}
          />
        )}
      </AreaFrame>
    );
  }
  const summary = state.value;
  const view = kinMoneyView(summary, kinListsOf(lists));
  const openRecord = (to: KinAttentionOpen) => {
    if (to.type === "record") navigation.navigate("KinWorkItem", { ...target, task: to.key });
  };
  const top = (
    <>
      {scopeNote === null ? null : (
        <Text textRole="body" className="px-2 text-foreground-muted">
          {scopeNote}
        </Text>
      )}
      <KinAttentionSection
        {...target}
        scope={{ type: "money" }}
        names={names}
        onOpen={openRecord}
      />
    </>
  );
  // Rates live in the company profile; a teammate can't read or set them.
  const ratesRow = !ratesAllowed ? null : (
    <KinFoldSection
      title={KIN_CURRENCY.rates}
      summary={
        rates === null || rates.rates.length === 0
          ? KIN_CURRENCY.setRate
          : rates.rates.map((rate) => kinRateLine(rate, rates.home)).join(", ")
      }
      onOpen={() =>
        navigation.navigate("KinRates", {
          environmentId: String(target.environmentId),
          orgId: String(target.orgId),
        })
      }
    />
  );
  if (view.empty) {
    // Adding stays in the bar; before the first agent, the way in is making one.
    const first = !scope.all ? null : agent !== null ? (
      <Button
        tone="primary"
        icon="bubble.left"
        label={KIN_MONEY.ask}
        onPress={() => agent.ask(KIN_MONEY.askMessage)}
      />
    ) : canAddLead ? (
      <Button
        tone="primary"
        label={KIN_MONEY.createChief}
        onPress={() => navigation.navigate("KinLeadForm", { ...target, suggest: "chief" })}
      />
    ) : null;
    return (
      <AreaFrame {...frame}>
        <View className="gap-4">{top}</View>
        <EmptyState
          variant="plain"
          {...(kinNothingShown("money", scope) ?? KIN_MONEY.none)}
          {...(first === null ? {} : { action: first })}
        />
        {ratesRow}
      </AreaFrame>
    );
  }
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
  const owedAbout = kinOwedAbout(summary, rates);
  const missing = kinMissingRates(
    [
      ...summary.owed.total,
      ...summary.spentThisFinancialYear,
      ...summary.receivedThisFinancialYear,
    ],
    rates,
  );
  return (
    <AreaFrame {...frame}>
      {top}
      <View className="gap-4">
        <View className="flex-row gap-4 px-2">
          <Figure figure={view.owed} onOpen={openList} estimates={estimates} />
          <Figure figure={view.overdue} onOpen={openList} estimates={estimates} />
        </View>
        {owedAbout === null && missing.length === 0 ? null : (
          <View className="gap-1 px-2">
            {owedAbout === null ? null : (
              <KinEstimateText text={owedAbout.text} basis={owedAbout.basis} />
            )}
            <KinSetRateLink {...target} currencies={missing} />
          </View>
        )}
        <ListSection title={KIN_MONEY.byClient}>
          {view.clients.length === 0 ? (
            <Text textRole="body" className="px-4 py-3 text-foreground-muted">
              {kinNothingOwed(scope)}
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
      <KinOutlookSection {...target} seq={seq} rates={rates} />
      <KinCashSection {...target} seq={seq} rates={rates} />
      <View className="gap-2">
        <KinFoldSection
          title={view.monthLabel}
          summary={KIN_MONEY.monthSummary(view.received.lines, view.spent.lines)}
        >
          <View className="flex-row gap-4 bg-grouped-card px-4 py-2.5">
            <Figure figure={view.received} onOpen={openList} estimates={estimates} />
            <Figure figure={view.spent} onOpen={openList} estimates={estimates} />
          </View>
          {view.tdsDeducted === null ? null : (
            <View className="flex-row gap-4 bg-grouped-card px-4 py-2.5">
              <Figure figure={view.tdsDeducted} onOpen={openList} />
            </View>
          )}
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
        </KinFoldSection>
        <KinQuotesSection {...target} seq={seq} rates={rates} lists={kinListsOf(lists)} />
        <KinBudgetsSection {...target} seq={seq} rates={rates} lists={kinListsOf(lists)} />
        <KinSubscriptionsSection
          {...target}
          lists={kinListsOf(lists)}
          directory={props.directory}
          seq={seq}
          rates={rates}
        />
        {summary.upcomingTotal === 0 ? null : datesAllowed ? (
          <KinFoldSection
            title={KIN_MONEY.upcoming}
            summary={KIN_MONEY.upcomingCount(summary.upcomingTotal)}
            onOpen={() => navigation.navigate("KinDates", target)}
          />
        ) : (
          // A teammate can't read the whole calendar; what Money already sent unfolds here.
          <KinFoldSection
            title={KIN_MONEY.upcoming}
            summary={KIN_MONEY.upcomingCount(summary.upcomingTotal)}
          >
            {kinDatesAgenda(summary.upcoming, names, now).flatMap((day) =>
              day.rows.map((row) => (
                <KinDateRowLine
                  key={row.id}
                  row={row}
                  onPress={() => navigation.navigate("KinWorkItem", { ...target, task: row.key })}
                />
              )),
            )}
          </KinFoldSection>
        )}
        <KinReceiptsSection {...target} seq={seq} />
        <KinGoals {...target} seq={seq} />
        <KinFoldSection title={view.yearLabel} summary={null}>
          <View className="flex-row gap-4 bg-grouped-card px-4 py-2.5">
            <Figure figure={view.yearReceived} onOpen={openList} estimates={estimates} />
            <Figure figure={view.yearSpent} onOpen={openList} estimates={estimates} />
          </View>
          {view.yearTdsDeducted === null ? null : (
            <View className="flex-row gap-4 bg-grouped-card px-4 py-2.5">
              <Figure figure={view.yearTdsDeducted} onOpen={openList} />
            </View>
          )}
          {view.charts.map((chart) => (
            <View
              key={chart.unit.kind === "money" ? chart.unit.currency : ""}
              className="bg-grouped-card px-4 py-2.5"
            >
              <KinChart view={kinChartView(chart)} />
            </View>
          ))}
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
        </KinFoldSection>
        {ratesRow}
      </View>
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
