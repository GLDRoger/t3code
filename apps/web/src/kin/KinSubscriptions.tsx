import { useAtomValue } from "@effect/atom-react";
import { kinRateDay, type KinRates } from "@t3tools/client-runtime/kin/kinCurrency";
import { KIN_LIST_DEFAULT_FILTER } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_SUBSCRIPTIONS,
  kinFinancialYearStart,
  kinSubscriptionActions,
  kinSubscriptionsList,
  kinSubscriptionsView,
  type KinFigureLine,
  type KinSubscriptionRow,
  type KinSubscriptionUndo,
} from "@t3tools/client-runtime/kin/kinSubscriptions";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinListDefinition, KinRecordKey } from "@t3tools/contracts";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { KinEstimateText, KinSetRateButton } from "./KinMoneyEstimate";
import {
  KinWorkNotice,
  KinWorkRowSkeletons,
  KinWorkSection,
  KinLoadFailed,
  KinWorkStaleLine,
} from "./KinWorkParts";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { kinHostConnected } from "./useKinHost";
import {
  kinListsOf,
  useKinAskAgent,
  useKinListContext,
  useKinListEntries,
  useKinLists,
  useKinRates,
} from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const ALL = { ...KIN_LIST_DEFAULT_FILTER, show: "all" as const };
const OPENS =
  "rounded-md outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** The subscriptions list's entries, read the way Money reads them, live. */
function useKinSubscriptions(
  target: KinWorkTarget,
  def: KinListDefinition,
  directory: KinWorkDirectory,
  seq: number | null,
  rates: KinRates | null,
) {
  const context = useKinListContext(target, directory);
  const { state, entries } = useKinListEntries(target, def.list, ALL, seq);
  const view = kinSubscriptionsView(
    def,
    state.records,
    context,
    rates,
    kinFinancialYearStart(new Date(useNowMinuteMs()), context.yearStartMonth),
  );
  return { state, entries, view };
}

/** A figure with a line per currency, each foreign one with its estimate under it. */
function Lines(props: {
  readonly label: string;
  readonly lines: ReadonlyArray<KinFigureLine>;
  readonly basis: ReadonlyArray<string>;
  readonly note?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5 px-2 py-1.5">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      {props.lines.length === 0 ? (
        <span className="text-xl font-semibold tracking-tight text-foreground">Nothing</span>
      ) : (
        props.lines.map((line) => (
          <span key={line.currency} className="flex flex-col items-start">
            <span className="text-xl font-semibold tracking-tight text-foreground tabular-nums">
              {line.text}
            </span>
            {line.estimate === null ? null : (
              <KinEstimateText text={line.estimate} basis={props.basis} />
            )}
          </span>
        ))
      )}
      {props.note === undefined ? null : (
        <span className="text-xs text-muted-foreground">{props.note}</span>
      )}
    </div>
  );
}

/** One subscription: what and what for on the left; its amount, estimate and renewal on the right. */
function SubscriptionRow(props: {
  readonly row: KinSubscriptionRow;
  readonly busy: boolean;
  readonly canChange: boolean;
  readonly onOpen: () => void;
  readonly onCancel?: () => void;
  readonly onUndo?: () => void;
}) {
  const { row } = props;
  return (
    <div className="flex items-center gap-2 border-b border-border/60 py-1 last:border-b-0">
      <button
        type="button"
        aria-label={row.accessibilityLabel}
        onClick={props.onOpen}
        className={cn("flex min-w-0 flex-1 items-start gap-3 px-2 py-1.5 text-start", OPENS)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "truncate text-sm",
              row.cancelled ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {row.title}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {[row.purpose, row.cycle, row.who].filter(Boolean).join(" · ")}
          </span>
          <span
            className={cn(
              "truncate text-xs font-medium",
              row.cancelled ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {row.cancelled ? `${KIN_SUBSCRIPTIONS.cancelled} · ${row.when}` : row.when}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end text-sm text-foreground tabular-nums">
          {row.amount}
          {row.estimate === null ? null : (
            <span className="text-xs text-muted-foreground">{row.estimate}</span>
          )}
        </span>
      </button>
      {props.canChange && props.onUndo !== undefined ? (
        <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onUndo}>
          {KIN_SUBSCRIPTIONS.undoCancel}
        </Button>
      ) : null}
      {props.canChange && props.onCancel !== undefined ? (
        <Button
          size="xs"
          variant="ghost"
          aria-label={`${KIN_SUBSCRIPTIONS.cancel}: ${row.title}`}
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

/** Money's Subscriptions: one line of what they cost a month, opening the full view. */
export function KinSubscriptionsSection(
  props: KinWorkTarget & {
    readonly lists: ReadonlyArray<KinListDefinition>;
    readonly directory: KinWorkDirectory;
    readonly seq: number | null;
    readonly rates: KinRates | null;
    readonly onOpen: () => void;
  },
) {
  const def = kinSubscriptionsList(props.lists);
  // Absent until there is a list: Money's Add asks an agent to start one.
  if (def === null) return null;
  return <KinSubscriptionsLine {...props} def={def} />;
}

function KinSubscriptionsLine(
  props: KinWorkTarget & {
    readonly def: KinListDefinition;
    readonly directory: KinWorkDirectory;
    readonly seq: number | null;
    readonly rates: KinRates | null;
    readonly onOpen: () => void;
  },
) {
  const { view, state } = useKinSubscriptions(
    props,
    props.def,
    props.directory,
    props.seq,
    props.rates,
  );
  return (
    <KinWorkSection
      title={KIN_SUBSCRIPTIONS.title}
      fold={{
        summary: state.loading && state.records.length === 0 ? null : view.summary,
        onOpen: props.onOpen,
      }}
    >
      {null}
    </KinWorkSection>
  );
}

/** Subscriptions as their own view beside Money: figures per currency, what renews, every one. */
export function KinSubscriptionsPage(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const seq = props.stale ? null : props.live.seq;
  const lists = useKinLists(props, { enabled: true });
  const rates = useKinRates(props);
  const def = kinSubscriptionsList(kinListsOf(lists));
  if (lists.state._tag === "refused")
    return <KinWorkNotice title="Not available" detail={KIN_SUBSCRIPTIONS.moneyKept} />;
  if (lists.state._tag !== "ready")
    return lists.state._tag === "loading" ? (
      <div
        className="mx-auto w-full max-w-3xl p-4"
        role="status"
        aria-label="Loading subscriptions"
      >
        <KinWorkRowSkeletons />
      </div>
    ) : (
      <KinLoadFailed
        what={KIN_SUBSCRIPTIONS.loadFailed}
        cause={lists.state._tag === "failed" ? lists.state.cause : null}
        onRetry={lists.refresh}
        className="mx-auto w-full max-w-3xl p-4"
      />
    );
  if (def === null) return <KinWorkNotice {...KIN_SUBSCRIPTIONS.none} />;
  return <KinSubscriptionsBody {...props} def={def} seq={seq} rates={rates} />;
}

function KinSubscriptionsBody(
  props: KinWorkTarget & {
    readonly def: KinListDefinition;
    readonly directory: KinWorkDirectory;
    readonly seq: number | null;
    readonly stale: boolean;
    readonly rates: KinRates | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const { environmentId, orgId } = props;
  const { view, state, entries } = useKinSubscriptions(
    props,
    props.def,
    props.directory,
    props.seq,
    props.rates,
  );
  const agent = useKinAskAgent(props);
  const update = useAtomCommand(kinClient.workUpdate, { reportFailure: false });
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [undo, setUndo] = useState<KinSubscriptionUndo | null>(null);
  const actions = kinSubscriptionActions({
    environmentId,
    orgId,
    def: props.def,
    online: () => kinHostConnected(environmentId),
    update,
    refresh: entries.refresh,
    set: { busy: setBusy, problem: setProblem, undo: setUndo },
  });
  const basis = (props.rates?.rates ?? []).map(
    (rate) => `${rate.currency}: ${props.rates?.home} ${rate.rate} as of ${kinRateDay(rate.asOf)}`,
  );
  const rows = (list: ReadonlyArray<KinSubscriptionRow>, cancelled: boolean) =>
    list.map((row) => (
      <SubscriptionRow
        key={row.key}
        row={row}
        busy={busy !== null}
        canChange={canChange && actions.cancellable}
        onOpen={() => props.onOpenKey(row.key as KinRecordKey)}
        {...(cancelled
          ? { onUndo: () => void actions.restore(row) }
          : { onCancel: () => void actions.cancel(row) })}
      />
    ));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      <div
        className={cn(
          "mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-4",
          state.refreshing && "opacity-70",
        )}
      >
        <div className="flex flex-wrap items-center gap-2 px-2">
          <h2 className="text-sm font-medium text-foreground">{KIN_SUBSCRIPTIONS.title}</h2>
          {agent === null ? null : (
            <div className="ms-auto flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => agent.ask(KIN_SUBSCRIPTIONS.askAbout)}
              >
                <MessageSquareIcon />
                Ask {agent.name}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => agent.ask(KIN_SUBSCRIPTIONS.addMessage)}
              >
                <PlusIcon />
                {KIN_SUBSCRIPTIONS.add}
              </Button>
            </div>
          )}
        </div>
        {props.stale || state.stale ? (
          <div className="px-2">
            <KinWorkStaleLine environmentId={environmentId} onRetry={entries.refresh} />
          </div>
        ) : null}
        {problem === null ? null : (
          <Alert variant="error">
            <AlertDescription>{problem}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={() => setProblem(null)}>
                Dismiss
              </Button>
            </AlertAction>
          </Alert>
        )}
        {undo === null ? null : (
          <Alert variant="success">
            <AlertDescription>Marked {undo.title} cancelled.</AlertDescription>
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => actions.undo(undo, view.cancelled)}
              >
                Undo
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setUndo(null)}>
                Dismiss
              </Button>
            </AlertAction>
          </Alert>
        )}
        {state.loading && state.records.length === 0 ? (
          <div role="status" aria-label="Loading subscriptions">
            <KinWorkRowSkeletons />
          </div>
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                <Lines
                  label={KIN_SUBSCRIPTIONS.monthly}
                  lines={view.monthly}
                  basis={basis}
                  note={KIN_SUBSCRIPTIONS.monthlyNote}
                />
                <Lines label={KIN_SUBSCRIPTIONS.runRate} lines={view.runRate} basis={basis} />
                <Lines label={KIN_SUBSCRIPTIONS.thisMonth} lines={view.thisMonth} basis={basis} />
                <Lines label={KIN_SUBSCRIPTIONS.yearSoFar} lines={view.yearSoFar} basis={basis} />
              </div>
              <div className="flex flex-col items-start gap-1 px-2">
                {view.monthlyAll === null ? null : (
                  <KinEstimateText text={`${view.monthlyAll} a month (estimate)`} basis={basis} />
                )}
                <KinSetRateButton {...props} currencies={view.missingRates} />
                {view.uncounted === 0 ? null : (
                  <p className="text-xs text-muted-foreground">
                    {view.uncounted === 1
                      ? "1 has no cycle set, so it isn't in these figures."
                      : `${view.uncounted} have no cycle set, so they aren't in these figures.`}
                  </p>
                )}
              </div>
            </section>
            <KinWorkSection title={KIN_SUBSCRIPTIONS.renewing}>
              {view.renewing.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">
                  {KIN_SUBSCRIPTIONS.nothingRenewing}
                </p>
              ) : (
                <div className="flex flex-col">{rows(view.renewing, false)}</div>
              )}
            </KinWorkSection>
            <KinWorkSection title={`${KIN_SUBSCRIPTIONS.active} · ${view.active.length}`}>
              {view.active.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">Nothing active.</p>
              ) : (
                <div className="flex flex-col">{rows(view.active, false)}</div>
              )}
            </KinWorkSection>
            {view.cancelled.length === 0 ? null : (
              <KinWorkSection title={`${KIN_SUBSCRIPTIONS.cancelled} · ${view.cancelled.length}`}>
                <div className="flex flex-col">{rows(view.cancelled, true)}</div>
              </KinWorkSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}
