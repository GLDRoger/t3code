import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_RETRY, KIN_CHECK_CONNECTION } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
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
  type KinSubscriptionsView,
} from "@t3tools/client-runtime/kin/kinSubscriptions";
import { kinRateDay, type KinRates } from "@t3tools/client-runtime/kin/kinCurrency";
import { EnvironmentId, KinOrgId, type KinListDefinition } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinFoldSection, KinWorkLoading, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { KinEstimateText, KinSetRateLink } from "./KinMoneyEstimate";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";
import {
  kinListsOf,
  useKinAskAgent,
  useKinListContext,
  useKinListEntries,
  useKinLists,
  useKinRates,
} from "./state/useKinMoney";
import {
  refreshKinWorkLive,
  useKinWork,
  useKinWorkDirectory,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

const ALL = { ...KIN_LIST_DEFAULT_FILTER, show: "all" as const };

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
    <View className="min-w-0 flex-1 gap-0.5">
      <Text textRole="footnote" className="text-foreground-muted">
        {props.label}
      </Text>
      {props.lines.length === 0 ? (
        <Text textRole="title" className="font-t3-bold text-foreground">
          Nothing
        </Text>
      ) : (
        props.lines.map((line) => (
          <View key={line.currency}>
            <Text textRole="title" selectable className="font-t3-bold tabular-nums text-foreground">
              {line.text}
            </Text>
            {line.estimate === null ? null : (
              <KinEstimateText text={line.estimate} basis={props.basis} />
            )}
          </View>
        ))
      )}
      {props.note === undefined ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.note}
        </Text>
      )}
    </View>
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
  const grows = useKinTextGrows();
  const { row } = props;
  return (
    <View className="flex-row items-center gap-3 bg-grouped-card px-4 py-2.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.accessibilityLabel}
        onPress={props.onOpen}
        className="min-w-0 flex-1 flex-row items-start gap-3 active:opacity-60"
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            textRole="body"
            numberOfLines={kinLines(1, grows)}
            className={row.cancelled ? "text-foreground-muted" : "text-foreground"}
          >
            {row.title}
          </Text>
          <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
            {[row.purpose, row.cycle, row.who].filter(Boolean).join(" · ")}
          </Text>
          <Text
            textRole="footnote"
            numberOfLines={2}
            className={cn(
              "font-t3-medium",
              row.cancelled ? "text-danger-foreground" : "text-foreground-muted",
            )}
          >
            {row.cancelled ? `${KIN_SUBSCRIPTIONS.cancelled} · ${row.when}` : row.when}
          </Text>
        </View>
        <View className="items-end gap-0.5">
          {row.amount === null ? null : (
            <Text textRole="body" className="tabular-nums text-foreground">
              {row.amount}
            </Text>
          )}
          {row.estimate === null || row.estimateBasis === null ? null : (
            <KinEstimateText text={row.estimate} basis={row.estimateBasis} align="end" />
          )}
        </View>
      </Pressable>
      {!props.canChange ? null : props.onUndo !== undefined ? (
        <Button
          tone="secondary"
          size="compact"
          label={KIN_SUBSCRIPTIONS.undoCancel}
          disabled={props.busy}
          onPress={props.onUndo}
        />
      ) : null}
      {props.canChange && props.onCancel !== undefined ? (
        <Button
          tone="secondary"
          size="compact"
          label="Cancel"
          accessibilityLabel={`${KIN_SUBSCRIPTIONS.cancel}: ${row.title}`}
          disabled={props.busy}
          onPress={props.onCancel}
        />
      ) : null}
    </View>
  );
}

/** Money's Subscriptions: one row of what they cost a month, opening the full view. */
export function KinSubscriptionsSection(
  props: KinWorkTarget & {
    readonly lists: ReadonlyArray<KinListDefinition>;
    readonly directory: KinWorkDirectory;
    readonly seq: number | null;
    readonly rates: KinRates | null;
  },
) {
  const def = kinSubscriptionsList(props.lists);
  const navigation = useNavigation();
  // Absent until there is a list: Money's Add asks an agent to start one.
  if (def === null) return null;
  return (
    <KinSubscriptionsLine
      {...props}
      def={def}
      onOpen={() =>
        navigation.navigate("KinSubscriptions", {
          environmentId: String(props.environmentId),
          orgId: String(props.orgId),
        })
      }
    />
  );
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
    <KinFoldSection
      title={KIN_SUBSCRIPTIONS.title}
      summary={state.loading && state.records.length === 0 ? null : view.summary}
      onOpen={props.onOpen}
    />
  );
}

export type KinSubscriptionsParams = { readonly environmentId: string; readonly orgId: string };
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** Subscriptions as their own view: figures per currency, what renews, every active and cancelled one. */
export function KinSubscriptionsScreen({ route }: StaticScreenProps<KinSubscriptionsParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null)
    return (
      <Frame target={null} onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't open Subscriptions"
          detail="Open Money from Kin."
        />
      </Frame>
    );
  return <KinSubscriptionsGate environmentId={environmentId} orgId={orgId} />;
}

function Frame(props: {
  readonly target: KinWorkTarget | null;
  readonly onBack: () => void;
  readonly onRefresh?: () => void;
  readonly children: React.ReactNode;
}) {
  const agent = useKinAskAgent(
    props.target ?? { environmentId: "" as EnvironmentId, orgId: "" as KinOrgId },
  );
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_SUBSCRIPTIONS.title}
        onBack={props.onBack}
        {...(props.onRefresh === undefined
          ? {}
          : { refresh: { accessibilityLabel: "Refresh", onPress: props.onRefresh } })}
        {...(agent === null || props.target === null
          ? {}
          : {
              actions: [
                {
                  accessibilityLabel: `Ask ${agent.name}`,
                  icon: "bubble.left" as const,
                  onPress: () => agent.ask(KIN_SUBSCRIPTIONS.askAbout),
                },
                {
                  accessibilityLabel: KIN_SUBSCRIPTIONS.add,
                  icon: "plus" as const,
                  onPress: () => agent.ask(KIN_SUBSCRIPTIONS.addMessage),
                },
              ],
            })}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 24 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinSubscriptionsGate(props: KinWorkTarget) {
  const navigation = useNavigation();
  const work = useKinWork(props);
  const ready = work._tag === "ready";
  const directory = useKinWorkDirectory(props, ready);
  const seq = ready && !work.stale ? work.live.seq : null;
  const lists = useKinLists(props, { enabled: ready });
  const rates = useKinRates(props, ready);
  const back = () => navigation.goBack();
  const def = kinSubscriptionsList(kinListsOf(lists));
  if (work._tag === "refused" || lists.state._tag === "refused")
    return (
      <Frame target={props} onBack={back}>
        <EmptyState variant="plain" {...KIN_MONEY.onlyOwner} />
      </Frame>
    );
  if (!ready || lists.state._tag !== "ready")
    return (
      <Frame target={props} onBack={back}>
        {lists.state._tag === "failed" ? (
          <EmptyState
            variant="plain"
            title={KIN_SUBSCRIPTIONS.loadFailed}
            detail={KIN_CHECK_CONNECTION}
            action={<Button tone="secondary" label={KIN_RETRY} onPress={lists.refresh} />}
          />
        ) : (
          <KinWorkLoading label="Loading subscriptions" />
        )}
      </Frame>
    );
  if (def === null)
    return (
      <Frame target={props} onBack={back}>
        <EmptyState variant="plain" {...KIN_SUBSCRIPTIONS.none} />
      </Frame>
    );
  return (
    <KinSubscriptionsBody
      {...props}
      def={def}
      directory={directory}
      seq={seq}
      stale={work.stale}
      rates={rates}
    />
  );
}

function KinSubscriptionsBody(
  props: KinWorkTarget & {
    readonly def: KinListDefinition;
    readonly directory: KinWorkDirectory;
    readonly seq: number | null;
    readonly stale: boolean;
    readonly rates: KinRates | null;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const { view, state, entries } = useKinSubscriptions(
    props,
    props.def,
    props.directory,
    props.seq,
    props.rates,
  );
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
  const open = (key: string) =>
    navigation.navigate("KinWorkItem", {
      environmentId: String(environmentId),
      orgId: String(orgId),
      task: key,
    });
  const refresh = () => {
    refreshKinWorkLive(props);
    entries.refresh();
    appAtomRegistry.refresh(kinClient.companyProfile({ environmentId, input: { orgId } }));
  };
  const basis = view.monthly.flatMap((line) => (line.estimate === null ? [] : [line.estimate]));
  const rateBasis = (props.rates?.rates ?? []).map(
    (rate) => `${rate.currency}: ${rate.rate} as of ${kinRateDay(rate.asOf)}`,
  );
  const rows = (list: ReadonlyArray<KinSubscriptionRow>, cancelled: boolean) =>
    list.map((row) => (
      <SubscriptionRow
        key={row.key}
        row={row}
        busy={busy !== null}
        canChange={canChange && actions.cancellable}
        onOpen={() => open(row.key)}
        {...(cancelled
          ? { onUndo: () => void actions.restore(row) }
          : { onCancel: () => void actions.cancel(row) })}
      />
    ));
  return (
    <Frame target={props} onBack={() => navigation.goBack()} onRefresh={refresh}>
      {props.stale || state.stale ? (
        <KinWorkStaleNotice environmentId={environmentId} onRetry={refresh} />
      ) : null}
      {problem === null ? null : (
        <Notice tone="danger" message={problem} onDismiss={() => setProblem(null)} />
      )}
      {undo === null ? null : (
        <Notice
          message={`Marked ${undo.title} cancelled.`}
          action={{
            label: "Undo",
            onPress: () => actions.undo(undo, view.cancelled),
          }}
          onDismiss={() => setUndo(null)}
        />
      )}
      {state.loading && state.records.length === 0 ? (
        <KinWorkLoading label="Loading subscriptions" />
      ) : state.records.length === 0 ? (
        <EmptyState variant="plain" {...KIN_SUBSCRIPTIONS.none} />
      ) : (
        <SubscriptionsFigures
          view={view}
          basis={basis.length > 0 ? rateBasis : []}
          target={props}
        />
      )}
      {view.renewing.length === 0 ? null : (
        <ListSection title={KIN_SUBSCRIPTIONS.renewing}>{rows(view.renewing, false)}</ListSection>
      )}
      {view.active.length === 0 ? null : (
        <ListSection title={`${KIN_SUBSCRIPTIONS.active} · ${view.active.length}`}>
          {rows(view.active, false)}
        </ListSection>
      )}
      {view.cancelled.length === 0 ? null : (
        <ListSection title={`${KIN_SUBSCRIPTIONS.cancelled} · ${view.cancelled.length}`}>
          {rows(view.cancelled, true)}
        </ListSection>
      )}
      {state.more ? (
        <Button
          tone="secondary"
          label="Show more"
          loading={state.loadingMore}
          onPress={() => void entries.loadMore()}
        />
      ) : null}
    </Frame>
  );
}

function SubscriptionsFigures(props: {
  readonly view: KinSubscriptionsView;
  readonly basis: ReadonlyArray<string>;
  readonly target: KinWorkTarget;
}) {
  const { view } = props;
  return (
    <View className="gap-4 px-2">
      <View className="flex-row gap-4">
        <Lines
          label={KIN_SUBSCRIPTIONS.monthly}
          lines={view.monthly}
          basis={props.basis}
          note={KIN_SUBSCRIPTIONS.monthlyNote}
        />
        <Lines label={KIN_SUBSCRIPTIONS.runRate} lines={view.runRate} basis={props.basis} />
      </View>
      {view.monthlyAll === null ? null : (
        <KinEstimateText text={`${view.monthlyAll} a month (estimate)`} basis={props.basis} />
      )}
      {view.missingRates.length === 0 ? null : (
        <KinSetRateLink {...props.target} currencies={view.missingRates} />
      )}
      <View className="flex-row gap-4">
        <Lines label={KIN_SUBSCRIPTIONS.thisMonth} lines={view.thisMonth} basis={props.basis} />
        <Lines label={KIN_SUBSCRIPTIONS.yearSoFar} lines={view.yearSoFar} basis={props.basis} />
      </View>
      {view.uncounted === 0 ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {view.uncounted === 1
            ? "1 subscription has no cycle, so it isn't in these figures."
            : `${view.uncounted} subscriptions have no cycle, so they aren't in these figures.`}
        </Text>
      )}
    </View>
  );
}
