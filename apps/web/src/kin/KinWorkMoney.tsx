import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import { kinDateRowView } from "@t3tools/client-runtime/kin/kinDates";
import { KIN_LISTS } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_MONEY,
  kinMoneyHeadline,
  kinMoneyView,
  type KinListOpen,
  type KinMoneyFigure,
} from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_WORK_STALE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecordKey } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { KinChart } from "./KinChart";
import { KinReceiptsSection } from "./KinReceipts";
import { KinDateRow } from "./KinWorkDates";
import { useNowMinuteMs } from "./useKinClock";
import { KinWorkNotice, KinWorkRowSkeletons, KinWorkSection } from "./KinWorkParts";
import { kinListsOf, useKinAskAgent, useKinMoneySummary, type KinListsHandle } from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const OPENS =
  "rounded-md outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** One figure, a line per currency. It opens the entries it was added up from. */
function Figure(props: {
  readonly figure: KinMoneyFigure;
  readonly onOpen: (open: KinListOpen) => void;
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
          <span key={amount}>{amount}</span>
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

/** Work's headline money lines, over the task list; they open Money. */
export function KinMoneyHeadline(
  props: KinWorkTarget & { readonly seq: number | null; readonly onOpen: () => void },
) {
  const { state } = useKinMoneySummary(props, { enabled: true, seq: props.seq });
  if (state._tag !== "ready") return null;
  const lines = kinMoneyHeadline(state.value);
  if (lines.length === 0) return null;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`${KIN_MONEY.title}. ${lines.join(". ")}`}
      className={cn("flex w-full flex-col gap-0.5 px-2 py-1.5 text-start", OPENS)}
    >
      <span className="text-xs font-medium text-muted-foreground">{KIN_MONEY.title}</span>
      <span className="text-sm text-foreground tabular-nums">{lines.slice(0, 2).join(" · ")}</span>
      {lines.length > 2 ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {lines.slice(2).join(" · ")}
        </span>
      ) : null}
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
    readonly onLists: () => void;
    readonly onClients: () => void;
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
    );
  }
  const upcoming = summary.upcoming.map((row) => kinDateRowView(row, names, now));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-4">
        {props.stale || state.stale ? (
          <p role="status" className="text-xs text-muted-foreground">
            {KIN_WORK_STALE}
          </p>
        ) : null}
        <section className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Figure figure={view.owed} onOpen={props.onOpenList} />
            <Figure figure={view.overdue} onOpen={props.onOpenList} />
          </div>
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
            <Figure figure={view.received} onOpen={props.onOpenList} />
            <Figure figure={view.spent} onOpen={props.onOpenList} />
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
                        onOpen={open === null ? null : () => props.onOpenList(open)}
                      />
                    </li>
                  );
                })}
              </ul>
            </KinWorkSection>
          )}
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="px-2 text-sm font-medium text-foreground">{view.yearLabel}</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Figure figure={view.yearReceived} onOpen={props.onOpenList} />
            <Figure figure={view.yearSpent} onOpen={props.onOpenList} />
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
          <Button size="sm" variant="outline" onClick={props.onLists}>
            {KIN_LISTS.title}
          </Button>
          <Button size="sm" variant="outline" onClick={props.onClients}>
            {KIN_MONEY.clients}
          </Button>
          {agent === null ? null : (
            <Button size="sm" variant="ghost" onClick={() => agent.ask("")}>
              <MessageSquareIcon />
              Ask {agent.name}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
