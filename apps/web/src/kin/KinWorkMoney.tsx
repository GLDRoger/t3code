import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import { kinDateRowView } from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_MONEY,
  kinMoneyView,
  type KinListOpen,
  type KinMoneyFigure,
} from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_WORK_STALE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  kinEstimatesByLine,
  kinMissingRates,
  kinTotalsEstimate,
  type KinEstimate,
} from "@t3tools/client-runtime/kin/kinCurrency";
import type { KinRecordKey } from "@t3tools/contracts";
import { ArrowLeftRightIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { KinChart } from "./KinChart";
import { KinEstimateText, KinRatesDialog, KinSetRateButton } from "./KinMoneyEstimate";
import { KinSubscriptionsSection } from "./KinSubscriptions";
import { KinReceiptsSection } from "./KinReceipts";
import { KinDateRow } from "./KinWorkDates";
import { KinAttentionSection } from "./KinAttention";
import { KinGoals } from "./KinGoals";
import { useNowMinuteMs } from "./useKinClock";
import { KinWorkNotice, KinWorkRowSkeletons, KinWorkSection } from "./KinWorkParts";
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

/**
 * Money: who owes us and how late, what came in and went out, the year so far and what is due.
 * The host adds everything up; this only lays it out and says where each figure came from.
 */
export function KinWorkMoney(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly lists: KinListsHandle;
    readonly onOpenList: (open: KinListOpen) => void;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onDates: () => void;
    readonly onSubscriptions: () => void;
    readonly onOpenDoc: (key: KinRecordKey) => void;
  },
) {
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const { state, refresh } = useKinMoneySummary(props, {
    enabled: true,
    seq: props.stale ? null : props.live.seq,
  });
  const agent = useKinAskAgent(props);
  const rates = useKinRates(props);
  const top = (
    <>
      <KinGoals {...props} seq={props.stale ? null : props.live.seq} />
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
  if (state._tag === "refused") return <KinWorkNotice {...KIN_MONEY.onlyOwner} />;
  if (state._tag === "failed" || state._tag === "gone") {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{KIN_MONEY.loadFailed}. Check your connection.</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
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
    return (
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-4">{top}</div>
        <KinWorkNotice
          {...KIN_MONEY.none}
          {...(agent === null
            ? {}
            : {
                action: (
                  <Button onClick={() => agent.ask(KIN_MONEY.askMessage)}>
                    <MessageSquareIcon />
                    {KIN_MONEY.ask}
                  </Button>
                ),
              })}
        />
      </div>
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
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-4">
        {props.stale || state.stale ? (
          <p role="status" className="text-xs text-muted-foreground">
            {KIN_WORK_STALE}
          </p>
        ) : null}
        {top}
        <section className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Figure figure={view.owed} onOpen={props.onOpenList} estimates={estimates} />
            <Figure figure={view.overdue} onOpen={props.onOpenList} estimates={estimates} />
          </div>
          {owedAll?.all == null && missing.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-x-3 px-2">
              {owedAll?.all == null ? null : (
                <KinEstimateText
                  text={`${owedAll.all} owed (estimate)`}
                  basis={owedAll.basis.map((line) => `At ${line}.`)}
                />
              )}
              <KinSetRateButton {...props} currencies={missing} />
            </div>
          )}
          <KinWorkSection title={KIN_MONEY.byClient}>
            {view.clients.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">{KIN_MONEY.nothingOwed}</p>
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
              </ul>
            )}
          </KinWorkSection>
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="px-2 text-sm font-medium text-foreground">{view.monthLabel}</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Figure figure={view.received} onOpen={props.onOpenList} estimates={estimates} />
            <Figure figure={view.spent} onOpen={props.onOpenList} estimates={estimates} />
            {view.tdsDeducted === null ? null : (
              <Figure figure={view.tdsDeducted} onOpen={props.onOpenList} estimates={estimates} />
            )}
          </div>
          {view.categories.length === 0 ? null : (
            <KinWorkSection title={KIN_MONEY.byCategory}>
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
            </KinWorkSection>
          )}
        </section>
        <KinSubscriptionsSection
          {...props}
          lists={kinListsOf(props.lists)}
          seq={props.stale ? null : props.live.seq}
          rates={rates}
          onOpen={props.onSubscriptions}
          onOpenKey={props.onOpenKey}
        />
        <section className="flex flex-col gap-3">
          <h2 className="px-2 text-sm font-medium text-foreground">{view.yearLabel}</h2>
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
        </section>
        {view.charts.map((chart) => (
          <section key={chart.unit.kind === "money" ? chart.unit.currency : ""} className="px-2">
            <KinChart view={kinChartView(chart)} />
          </section>
        ))}
        {view.charts.length === 0 ? null : (
          <KinWorkSection title={KIN_MONEY.months}>
            <table className="w-full text-sm">
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
          </KinWorkSection>
        )}
        <KinReceiptsSection
          {...props}
          seq={props.stale ? null : props.live.seq}
          onOpenDoc={props.onOpenDoc}
          onOpenKey={props.onOpenKey}
        />
        <KinWorkSection
          title={KIN_MONEY.upcoming}
          action={
            <Button size="xs" variant="ghost" onClick={props.onDates}>
              {KIN_MONEY.allDates}
            </Button>
          }
        >
          {upcoming.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">{KIN_MONEY.nothingUpcoming}</p>
          ) : (
            <ul className="flex flex-col">
              {upcoming.map((row) => (
                <li key={row.id}>
                  <KinDateRow row={row} showDay onOpen={props.onOpenKey} />
                </li>
              ))}
            </ul>
          )}
          {summary.upcomingTotal > upcoming.length ? (
            <p className="px-2 text-xs text-muted-foreground">
              {summary.upcomingTotal - upcoming.length} more in {KIN_MONEY.allDates.toLowerCase()}.
            </p>
          ) : null}
        </KinWorkSection>
        <div className="flex flex-wrap gap-2 px-2">
          {rates === null ? null : (
            <Button size="sm" variant="ghost" onClick={() => setRatesOpen(true)}>
              <ArrowLeftRightIcon />
              Exchange rates
            </Button>
          )}
          {agent === null ? null : (
            <Button size="sm" variant="ghost" onClick={() => agent.ask("")}>
              <MessageSquareIcon />
              Ask {agent.name}
            </Button>
          )}
        </div>
      </div>
      {ratesOpen ? <KinRatesDialog {...props} onClose={() => setRatesOpen(false)} /> : null}
    </div>
  );
}
