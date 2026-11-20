import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import {
  KIN_MONEY,
  kinMoneyView,
  type KinListOpen,
  type KinMoneyFigure,
} from "@t3tools/client-runtime/kin/kinMoney";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  kinEstimatesByLine,
  kinMissingRates,
  kinOwedAbout,
  type KinEstimate,
} from "@t3tools/client-runtime/kin/kinCurrency";
import {
  kinNothingOwed,
  kinNothingShown,
  kinScopeNote,
} from "@t3tools/client-runtime/kin/kinViewerScope";
import type { KinRecordKey } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { KIN_GOALS } from "@t3tools/client-runtime/kin/kinAttention";
import { KIN_BUDGETS, KIN_QUOTES } from "@t3tools/client-runtime/kin/kinMoneyAnswers";
import { KIN_RECEIPTS } from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_SUBSCRIPTIONS } from "@t3tools/client-runtime/kin/kinSubscriptions";
import { ArrowLeftRightIcon, MessageSquareIcon, PlusIcon, BotIcon } from "lucide-react";
import { KIN_CHIEF_OF_STAFF } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { cn } from "../lib/utils";
import { KinChart } from "./KinChart";
import { KinCountryFirst } from "./KinCountryFirst";
import { KinEstimateText, KinRatesDialog, KinSetRateButton } from "./KinMoneyEstimate";
import { kinClient } from "./kinClient";
import {
  KinBudgetDialog,
  KinBudgetsSection,
  KinCashSection,
  KinOutlookSection,
  KinQuotesSection,
} from "./KinMoneyAnswers";
import { KinMoneySuggested } from "./KinMoneySuggested";
import { KinSubscriptionsSection } from "./KinSubscriptions";
import { KinNewReceiptDialog, KinReceiptsSection } from "./KinReceipts";
import { KinAttentionSection } from "./KinAttention";
import { KinGoalSheet, KinGoals } from "./KinGoals";
import { openKinLeadForm } from "./KinNewLeadButton";
import { useKinGoals } from "./useKinAttention";
import { useKinViewerScope } from "./useKinOwnerLevel";
import {
  KinWorkNotice,
  KinWorkRowSkeletons,
  KinWorkSection,
  KinLoadFailed,
  KinWorkStaleLine,
} from "./KinWorkParts";
import {
  kinListsOf,
  useKinAskAgent,
  useKinMoneySummary,
  useKinRates,
  type KinListsHandle,
} from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const OPENS =
  "rounded-md outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** One figure, a line per currency. It opens the entries it was added up from. */
function Figure(props: {
  readonly figure: KinMoneyFigure;
  readonly onOpen: (open: KinListOpen) => void;
  /** Each foreign line's "about ₹x", by line. */
  readonly estimates: ReadonlyMap<string, KinEstimate>;
}) {
  const { figure } = props;
  const { open } = figure;
  const body = (
    <>
      <span className="text-xs text-muted-foreground">{figure.label}</span>
      {figure.lines.map((line) => (
        <span
          key={line}
          className={cn(
            "text-xl font-semibold tracking-tight tabular-nums",
            figure.late ? "text-destructive-foreground" : "text-foreground",
          )}
        >
          {line}
          {/* Inside a button that opens the entries; the rate it is from shows beside the totals. */}
          {props.estimates.get(line) === undefined ? null : (
            <span className="block text-xs font-normal tracking-normal text-muted-foreground">
              {props.estimates.get(line)?.text}
            </span>
          )}
        </span>
      ))}
      {figure.note === null ? null : (
        <span className="text-xs text-muted-foreground">{figure.note}</span>
      )}
    </>
  );
  const shape = "flex min-w-0 flex-col items-start gap-0.5 px-2 py-1.5 text-start";
  return open === null ? (
    <div className={shape}>{body}</div>
  ) : (
    <button
      type="button"
      aria-label={`${figure.label}: ${figure.lines.join(" and ")}. Show the entries`}
      onClick={() => props.onOpen(open)}
      className={cn(shape, OPENS)}
    >
      {body}
    </button>
  );
}

/** A name on the left and its figure on the right; opens what is behind it when it can. */
function AmountRow(props: {
  readonly label: string;
  readonly note?: string | null;
  readonly late?: boolean;
  readonly amounts: ReadonlyArray<string>;
  readonly estimates: ReadonlyMap<string, KinEstimate>;
  readonly onOpen: (() => void) | null;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-foreground">{props.label}</span>
        {props.note == null ? null : (
          <span
            className={cn(
              "truncate text-xs",
              props.late ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {props.note}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end text-sm text-foreground tabular-nums">
        {props.amounts.map((amount) => (
          <span key={amount} className="flex flex-col items-end">
            {amount}
            {props.estimates.get(amount) === undefined ? null : (
              <span className="text-xs text-muted-foreground">
                {props.estimates.get(amount)?.text}
              </span>
            )}
          </span>
        ))}
      </span>
    </>
  );
  const shape = "flex w-full items-start gap-3 px-2 py-1.5 text-start";
  return props.onOpen === null ? (
    <div className={shape}>{body}</div>
  ) : (
    <button type="button" onClick={props.onOpen} className={cn(shape, OPENS)}>
      {body}
    </button>
  );
}

type MoneyProps = KinWorkTarget & {
  readonly live: KinWorkLive;
  readonly stale: boolean;
  readonly directory: KinWorkDirectory;
  readonly lists: KinListsHandle;
  readonly onOpenList: (open: KinListOpen) => void;
  readonly onOpenKey: (key: KinRecordKey) => void;
  readonly onDates: () => void;
  readonly onSubscriptions: () => void;
  readonly onOpenDoc: (key: KinRecordKey) => void;
};

/**
 * Money: who owes us and how late, what came in and went out, the year so far and what is due.
 * The host adds everything up; this only lays it out and says where each figure came from.
 */
export function KinWorkMoney(props: MoneyProps) {
  return (
    <KinCountryFirst environmentId={props.environmentId} waiting={<WaitingMoney {...props} />}>
      <MoneyScreen {...props} />
    </KinCountryFirst>
  );
}

/** Money while the country waits: no figures and nothing that records money; Dates and Goals stay. */
function WaitingMoney(props: MoneyProps) {
  const { state } = useKinMoneySummary(props, { enabled: true, use: "screen" });
  const goals = useKinGoals(props, { enabled: true, money: true });
  const [adding, setAdding] = useState(false);
  const upcoming = state._tag === "ready" ? state.value.upcomingTotal : 0;
  const none = goals.state._tag === "ready" && goals.state.value.goals.length === 0;
  return (
    <>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-4">
        {upcoming === 0 ? null : (
          <KinWorkSection
            title={KIN_MONEY.upcoming}
            fold={{ summary: KIN_MONEY.upcomingCount(upcoming), onOpen: props.onDates }}
          >
            {null}
          </KinWorkSection>
        )}
        <KinGoals {...props} goals={goals} />
        {/* With goals, their section has its own Add. */}
        {none && goals.canSave ? (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <PlusIcon />
              {KIN_GOALS.add}
            </Button>
          </div>
        ) : null}
      </div>
      {adding ? (
        <KinGoalSheet
          environmentId={props.environmentId}
          goal={null}
          goals={goals}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  );
}

function MoneyScreen(props: MoneyProps) {
  const { names } = props.directory;
  const { state, refresh } = useKinMoneySummary(props, { enabled: true, use: "screen" });
  const agent = useKinAskAgent(props);
  const rates = useKinRates(props);
  const goals = useKinGoals(props, { enabled: true, money: true });
  const canBudget = useAtomValue(kinClient.workSetBudget.permissionAtom(props.environmentId));
  const canReceipt = useAtomValue(kinClient.makeReceipt.permissionAtom(props.environmentId));
  const [adding, setAdding] = useState<"goal" | "budget" | "receipt" | null>(null);
  const scope = useKinViewerScope(props.environmentId);
  const scopeNote = kinScopeNote("money", scope);
  const top = (
    <>
      {scopeNote === null ? null : <p className="text-sm text-muted-foreground">{scopeNote}</p>}
      <KinAttentionSection
        {...props}
        scope={{ type: "money" }}
        names={names}
        onOpen={(to) => {
          if (to.type === "record") props.onOpenKey(to.key);
        }}
      />
    </>
  );
  const [ratesOpen, setRatesOpen] = useState(false);
  const canAddLead = useAtomValue(kinClient.leadCreate.permissionAtom(props.environmentId));
  const seq = props.stale ? null : props.live.seq;
  /** The page's own ways in; `withAsk` adds Ask, which an empty page already offers above. */
  const actions = (withAsk: boolean) => (
    <div className="flex flex-wrap gap-2">
      {!goals.canSave && !canBudget && !canReceipt && agent === null ? null : (
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="ghost" />}>
            <PlusIcon />
            {KIN_MONEY.add}
          </MenuTrigger>
          <MenuPopup align="start" side="top">
            {goals.canSave ? (
              <MenuItem onClick={() => setAdding("goal")}>{KIN_GOALS.add}</MenuItem>
            ) : null}
            {canBudget ? (
              <MenuItem onClick={() => setAdding("budget")}>{KIN_BUDGETS.add}</MenuItem>
            ) : null}
            {canReceipt ? (
              <MenuItem onClick={() => setAdding("receipt")}>{KIN_RECEIPTS.newReceipt}</MenuItem>
            ) : null}
            {agent === null ? null : (
              <MenuItem onClick={() => agent.ask(KIN_SUBSCRIPTIONS.addMessage)}>
                {KIN_SUBSCRIPTIONS.add}
              </MenuItem>
            )}
            {agent === null ? null : (
              <MenuItem onClick={() => agent.ask(KIN_QUOTES.askMessage)}>
                {KIN_MONEY.newQuote}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      )}
      {rates === null ? null : (
        <Button size="sm" variant="ghost" onClick={() => setRatesOpen(true)}>
          <ArrowLeftRightIcon />
          {KIN_MONEY.rates}
        </Button>
      )}
      {agent === null || !withAsk ? null : (
        <Button size="sm" variant="ghost" onClick={() => agent.ask("")}>
          <MessageSquareIcon />
          Ask {agent.name}
        </Button>
      )}
    </div>
  );
  const dialogs = (
    <>
      {adding === "goal" ? (
        <KinGoalSheet
          environmentId={props.environmentId}
          goal={null}
          goals={goals}
          onClose={() => setAdding(null)}
        />
      ) : adding === "budget" ? (
        <KinBudgetDialog
          {...props}
          seq={seq}
          rates={rates}
          expenses={kinListsOf(props.lists).find((one) => one.list === "expenses") ?? null}
          budget={null}
          onClose={() => setAdding(null)}
        />
      ) : adding === "receipt" ? (
        <KinNewReceiptDialog {...props} onClose={() => setAdding(null)} />
      ) : null}
      {ratesOpen ? <KinRatesDialog {...props} onClose={() => setRatesOpen(false)} /> : null}
    </>
  );
  if (state._tag === "refused") return <KinWorkNotice {...KIN_MONEY.onlyOwner} />;
  if (state._tag === "failed" || state._tag === "gone") {
    return (
      <KinLoadFailed
        what={KIN_MONEY.loadFailed}
        cause={state._tag === "failed" ? state.cause : null}
        onRetry={refresh}
        className="mx-auto w-full max-w-3xl p-4"
      />
    );
  }
  if (state._tag === "loading" || props.lists.state._tag === "loading") {
    return (
      <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading Money">
        <KinWorkRowSkeletons />
      </div>
    );
  }
  const summary = state.value;
  const view = kinMoneyView(summary, kinListsOf(props.lists));
  if (view.empty) {
    const first = !scope.all ? null : agent !== null ? (
      <Button onClick={() => agent.ask(KIN_MONEY.askMessage)}>
        <MessageSquareIcon />
        {KIN_MONEY.ask}
      </Button>
    ) : canAddLead ? (
      <Button
        onClick={() =>
          openKinLeadForm({
            environmentId: props.environmentId,
            orgId: props.orgId,
            lead: null,
            suggested: KIN_CHIEF_OF_STAFF,
          })
        }
      >
        <BotIcon />
        {KIN_MONEY.createChief}
      </Button>
    ) : null;
    return (
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-4">{top}</div>
        <KinWorkNotice
          {...(kinNothingShown("money", scope) ?? KIN_MONEY.none)}
          action={
            <div className="flex flex-col items-center gap-3">
              {first}
              {actions(false)}
            </div>
          }
        />
        {dialogs}
      </div>
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
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-4">
        {props.stale || state.stale ? (
          <KinWorkStaleLine environmentId={props.environmentId} onRetry={refresh} />
        ) : null}
        {top}
        <section className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Figure figure={view.owed} onOpen={props.onOpenList} estimates={estimates} />
            <Figure figure={view.overdue} onOpen={props.onOpenList} estimates={estimates} />
          </div>
          {owedAbout === null && missing.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-x-3 px-2">
              {owedAbout === null ? null : (
                <KinEstimateText text={owedAbout.text} basis={owedAbout.basis} />
              )}
              <KinSetRateButton {...props} currencies={missing} />
            </div>
          )}
          <KinWorkSection title={KIN_MONEY.byClient}>
            {view.clients.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">{kinNothingOwed(scope)}</p>
            ) : (
              <ul className="flex flex-col">
                {view.clients.map((client) => {
                  const { open } = client;
                  return (
                    <li key={client.key}>
                      <AmountRow
                        label={client.name}
                        note={client.overdue ?? client.invoices}
                        late={client.overdue !== null}
                        amounts={client.owed}
                        estimates={estimates}
                        onOpen={open === null ? null : () => props.onOpenList(open)}
                      />
                    </li>
                  );
                })}
                {view.clientsMore === null ? null : (
                  <li>
                    <MoreClients more={view.clientsMore} onOpen={props.onOpenList} />
                  </li>
                )}
              </ul>
            )}
          </KinWorkSection>
        </section>
        {view.suggested.length === 0 ? null : (
          <KinMoneySuggested
            {...props}
            rows={view.suggested}
            more={view.suggestedMore}
            onOpenKey={props.onOpenKey}
            onOpenList={props.onOpenList}
            onChanged={refresh}
          />
        )}
        <KinOutlookSection {...props} seq={seq} rates={rates} onOpenKey={props.onOpenKey} />
        <KinCashSection {...props} seq={seq} rates={rates} />
        <div className="flex flex-col gap-1">
          <KinWorkSection
            title={view.monthLabel}
            fold={{
              summary: KIN_MONEY.monthSummary(view.received.lines, view.spent.lines),
            }}
          >
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Figure figure={view.received} onOpen={props.onOpenList} estimates={estimates} />
              <Figure figure={view.spent} onOpen={props.onOpenList} estimates={estimates} />
              {view.tdsDeducted === null ? null : (
                <Figure figure={view.tdsDeducted} onOpen={props.onOpenList} estimates={estimates} />
              )}
            </div>
            {view.categories.length === 0 ? null : (
              <ul className="flex flex-col">
                {view.categories.map((category) => {
                  const { open } = category;
                  return (
                    <li key={category.key}>
                      <AmountRow
                        label={category.label}
                        amounts={[category.amount]}
                        estimates={estimates}
                        onOpen={open === null ? null : () => props.onOpenList(open)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </KinWorkSection>
          <KinQuotesSection
            {...props}
            lists={kinListsOf(props.lists)}
            seq={seq}
            rates={rates}
            onOpenKey={props.onOpenKey}
            onOpenList={props.onOpenList}
          />
          <KinBudgetsSection {...props} seq={seq} rates={rates} lists={props.lists} />
          <KinSubscriptionsSection
            {...props}
            lists={kinListsOf(props.lists)}
            seq={seq}
            rates={rates}
            onOpen={props.onSubscriptions}
          />
          {summary.upcomingTotal === 0 ? null : (
            <KinWorkSection
              title={KIN_MONEY.upcoming}
              fold={{
                summary: KIN_MONEY.upcomingCount(summary.upcomingTotal),
                onOpen: props.onDates,
              }}
            >
              {null}
            </KinWorkSection>
          )}
          <KinReceiptsSection {...props} onOpenDoc={props.onOpenDoc} onOpenKey={props.onOpenKey} />
          <KinGoals {...props} goals={goals} />
          <KinWorkSection title={view.yearLabel} fold={{ summary: null }}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Figure figure={view.yearReceived} onOpen={props.onOpenList} estimates={estimates} />
              <Figure figure={view.yearSpent} onOpen={props.onOpenList} estimates={estimates} />
              {view.yearTdsDeducted === null ? null : (
                <Figure
                  figure={view.yearTdsDeducted}
                  onOpen={props.onOpenList}
                  estimates={estimates}
                />
              )}
            </div>
            {view.charts.map((chart) => (
              <section
                key={chart.unit.kind === "money" ? chart.unit.currency : ""}
                className="px-2"
              >
                <KinChart view={kinChartView(chart)} />
              </section>
            ))}
            {view.charts.length === 0 ? null : (
              <table className="w-full text-sm">
                <caption className="px-2 py-1 text-start text-xs text-muted-foreground">
                  {KIN_MONEY.months}
                </caption>
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="px-2 py-1 text-start font-medium">
                      Month
                    </th>
                    <th scope="col" className="px-2 py-1 text-end font-medium">
                      {KIN_MONEY.received}
                    </th>
                    <th scope="col" className="px-2 py-1 text-end font-medium">
                      {KIN_MONEY.spent}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.months.map((month) => (
                    <tr key={month.month} className="border-t border-border/60">
                      <th scope="row" className="px-2 py-1 text-start font-normal text-foreground">
                        {month.label}
                      </th>
                      {(
                        [
                          [month.received, month.openReceived, KIN_MONEY.received],
                          [month.spent, month.openSpent, KIN_MONEY.spent],
                        ] as const
                      ).map(([amount, open, label]) => (
                        <td key={label} className="py-0.5 text-end tabular-nums">
                          {open === null ? (
                            <span className="px-2 text-muted-foreground">{amount}</span>
                          ) : (
                            <button
                              type="button"
                              aria-label={`${label} in ${month.label}: ${amount}. Show the entries`}
                              onClick={() => props.onOpenList(open)}
                              className={cn("px-2 py-0.5 text-foreground", OPENS)}
                            >
                              {amount}
                            </button>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </KinWorkSection>
        </div>
        <div className="px-2">{actions(true)}</div>
      </div>
      {dialogs}
    </div>
  );
}

function MoreClients(props: {
  readonly more: { readonly label: string; readonly open: KinListOpen | null };
  readonly onOpen: (open: KinListOpen) => void;
}) {
  const { open } = props.more;
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={open === null}
      onClick={open === null ? undefined : () => props.onOpen(open)}
    >
      {props.more.label}
    </Button>
  );
}
