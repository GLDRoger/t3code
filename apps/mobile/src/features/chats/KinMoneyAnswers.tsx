import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { KinRates } from "@t3tools/client-runtime/kin/kinCurrency";
import { KIN_INVOICES, kinConfirmTotal } from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_BANK, KIN_LIST_DEFAULT_FILTER } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_BUDGETS,
  KIN_CASH,
  KIN_EMPTY_LINE,
  KIN_LINES,
  KIN_OUTLOOK,
  KIN_QUOTES,
  KIN_QUOTES_LIST,
  kinBudgetDraftOf,
  kinBudgetInput,
  kinBudgetRemoval,
  kinBudgetsView,
  kinCashView,
  kinOutlookView,
  kinQuoteActions,
  kinQuoteInvoice,
  kinQuoteRow,
  kinQuotesSummary,
  kinBudgetsSummary,
  type KinBudgetDraft,
  type KinBudgetView,
  type KinLineDraft,
  type KinOutlookRowView,
  type KinQuoteRowView,
} from "@t3tools/client-runtime/kin/kinMoneyAnswers";
import {
  EnvironmentId,
  KinMoneyBudget,
  KinOrgId,
  type KinListDefinition,
  type KinRecordDetail,
  type KinRecordKey,
  type KinRecordState,
  KIN_DEFAULT_HOME_CURRENCY,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import type { KinMakeStep } from "./KinInvoice";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { KinLoadFailedRow } from "./components/KinLoadFailed";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { KinFoldSection, KinWorkFrame, KinWorkTextField } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import {
  kinListsOf,
  useKinAskAgent,
  useKinListEntries,
  useKinLists,
  useKinMoneyActions,
  useKinRates,
} from "./state/useKinMoney";
import {
  useKinBudgets,
  useKinBudgetSet,
  useKinCash,
  useKinInvoiceFromQuote,
  useKinOutlook,
} from "./state/useKinMoneyAnswers";
import { useKinWorkChoices, type KinWorkTarget } from "./state/useKinWork";
import { KinWorkPlacePicker } from "./components/KinWorkPlacePicker";
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";

const PEEK = 5;
type Section = KinWorkTarget & { readonly seq: number | null; readonly rates: KinRates | null };

/** A name and its note on the left; one amount and its "about ₹x" on the right. */
function Row(props: {
  readonly label: string;
  readonly note?: string | null;
  readonly late?: boolean;
  readonly amount: string | null;
  readonly estimate?: string | null;
  readonly extra?: ReadonlyArray<string>;
  readonly onPress?: () => void;
  readonly children?: React.ReactNode;
}) {
  const grows = useKinTextGrows();
  return (
    <Pressable
      accessibilityRole={props.onPress === undefined ? "text" : "button"}
      accessibilityLabel={[props.label, props.amount, props.note ?? null, ...(props.extra ?? [])]
        .filter((part) => part !== null && part !== "")
        .join(". ")}
      disabled={props.onPress === undefined}
      onPress={props.onPress}
      className="min-h-11 flex-row items-start gap-3 bg-grouped-card px-4 py-2.5 active:opacity-60"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" numberOfLines={kinLines(1, grows)} className="text-foreground">
          {props.label}
        </Text>
        {props.note == null || props.note === "" ? null : (
          <Text
            textRole="footnote"
            numberOfLines={kinLines(1, grows)}
            className={props.late ? "text-danger-foreground" : "text-foreground-muted"}
          >
            {props.note}
          </Text>
        )}
        {(props.extra ?? []).map((line) => (
          <Text key={line} textRole="footnote" className="text-foreground-muted">
            {line}
          </Text>
        ))}
        {props.children}
      </View>
      {props.amount === null ? null : (
        <View className="items-end">
          <Text textRole="body" className="tabular-nums text-foreground">
            {props.amount}
          </Text>
          {props.estimate == null ? null : (
            <Text textRole="footnote" className="tabular-nums text-foreground-muted">
              {props.estimate}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

function Plain(props: { readonly children: string; readonly danger?: boolean }) {
  return (
    <Text
      textRole="body"
      className={cn(
        "bg-grouped-card px-4 py-3",
        props.danger ? "text-danger-foreground" : "text-foreground-muted",
      )}
    >
      {props.children}
    </Text>
  );
}

const useOpenEntry = (target: KinWorkTarget) => {
  const navigation = useNavigation();
  return (task: KinRecordKey) => navigation.navigate("KinWorkItem", { ...target, task });
};

/** Bank balances of record, one line each; why a figure is held back sits behind Why. */
export function KinCashSection(props: Section) {
  const now = new Date(useNowMinuteMs());
  const { state, refresh } = useKinCash(props, true);
  const agent = useKinAskAgent(props, "money");
  const [why, setWhy] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  if (state._tag === "refused" || state._tag === "gone") return null;
  const view = state._tag === "ready" ? kinCashView(state.value, props.rates, now) : null;
  return (
    <ListSection title={KIN_CASH.title}>
      {state._tag === "loading" ? (
        <Plain>Loading…</Plain>
      ) : view === null ? (
        <KinLoadFailedRow
          title={KIN_CASH.loadFailed}
          cause={state._tag === "failed" ? state.cause : null}
          onRetry={refresh}
        />
      ) : (
        <>
          {view.known ? null : <Plain>{KIN_CASH.none}</Plain>}
          {view.accounts.map((one) => (
            <Row
              key={one.id}
              label={one.label}
              note={[one.when, one.flag].filter((part) => part !== null).join(" · ")}
              late={one.stale || one.flag !== null}
              amount={one.amount}
              estimate={one.estimate}
              extra={why === one.id ? one.notes : []}
            >
              {one.notes.length === 0 ? null : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setWhy(why === one.id ? null : one.id)}
                  hitSlop={8}
                  className="self-start active:opacity-60"
                >
                  <Text textRole="footnote" className="font-t3-medium text-primary">
                    {why === one.id ? KIN_CASH.hideWhy : KIN_CASH.why}
                  </Text>
                </Pressable>
              )}
            </Row>
          ))}
          {agent !== null ? (
            <ListActionRow
              label={KIN_BANK.upload}
              {...(view.bank === null ? {} : { description: view.bank })}
              onPress={() => agent.ask(KIN_BANK.uploadMessage)}
            />
          ) : view.bank === null ? null : (
            <Plain>{view.bank}</Plain>
          )}
          {view.currencies.map((one) => (
            <View key={one.currency} className="gap-1 bg-grouped-card px-4 py-2.5">
              <View className="flex-row justify-between gap-3">
                <Text textRole="footnote" className="text-foreground-muted">
                  {one.totalLabel}
                </Text>
                <View className="min-w-0 flex-1 items-end">
                  <Text textRole="body" className="text-right tabular-nums text-foreground">
                    {one.total ?? KIN_CASH.withheld}
                  </Text>
                  {one.totalEstimate === null ? null : (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {one.totalEstimate}
                    </Text>
                  )}
                </View>
              </View>
              {one.estimate === null ? null : (
                <View className="flex-row justify-between gap-3">
                  <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                    {`${KIN_CASH.estimate} (estimate)`}
                  </Text>
                  <View className="items-end">
                    <Text textRole="body" className="tabular-nums text-foreground">
                      {one.estimate}
                    </Text>
                    {one.estimateAbout === null ? null : (
                      <Text textRole="footnote" className="text-foreground-muted">
                        {one.estimateAbout}
                      </Text>
                    )}
                  </View>
                </View>
              )}
              {details ? (
                <>
                  <Text textRole="footnote" className="text-foreground-muted">
                    {`${one.recordedLabel}: ${KIN_CASH.in} ${one.received}, ${KIN_CASH.out} ${one.spent}`}
                  </Text>
                  {one.estimate === null ? null : (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {KIN_CASH.estimateNote}
                    </Text>
                  )}
                </>
              ) : null}
            </View>
          ))}
          {details
            ? view.notCounted.map((one) => (
                <Plain key={one.id}>{`${KIN_CASH.notCounted}: ${one.text}`}</Plain>
              ))
            : null}
          {view.currencies.length + view.notCounted.length === 0 ? null : (
            <ListActionRow
              label={details ? KIN_CASH.hideWhy : KIN_CASH.details}
              onPress={() => setDetails(!details)}
            />
          )}
        </>
      )}
    </ListSection>
  );
}

function OutlookRows(props: {
  readonly title: string;
  readonly rows: ReadonlyArray<KinOutlookRowView>;
  readonly all: boolean;
  readonly more: number;
  readonly onOpen: (key: KinRecordKey) => void;
}) {
  if (props.rows.length === 0 || !props.all) return null;
  return (
    <>
      <Text textRole="footnote" className="bg-grouped-card px-4 pt-2 text-foreground-muted">
        {props.title}
      </Text>
      {props.rows.map((row) => (
        <Row
          key={row.id}
          label={row.title}
          note={row.note}
          amount={row.amount}
          estimate={row.estimate}
          onPress={() => props.onOpen(row.key)}
        />
      ))}
      {props.all && props.more > 0 ? <Plain>{KIN_OUTLOOK.more(props.more)}</Plain> : null}
    </>
  );
}

/** What is expected in and out over the next 30 days, by currency, and runway. */
export function KinOutlookSection(props: Section) {
  const now = new Date(useNowMinuteMs());
  const open = useOpenEntry(props);
  const { state, refresh } = useKinOutlook(props, true);
  const [all, setAll] = useState(false);
  if (state._tag === "refused" || state._tag === "gone") return null;
  const view = state._tag === "ready" ? kinOutlookView(state.value, props.rates, now) : null;
  const longer = view !== null && view.incoming.length + view.outgoing.length > 0;
  return (
    <ListSection title={KIN_OUTLOOK.title}>
      {state._tag === "loading" ? (
        <Plain>Loading…</Plain>
      ) : view === null ? (
        <KinLoadFailedRow
          title={KIN_OUTLOOK.loadFailed}
          cause={state._tag === "failed" ? state.cause : null}
          onRetry={refresh}
        />
      ) : (
        <>
          {view.empty ? (
            <Plain>{KIN_OUTLOOK.empty}</Plain>
          ) : (
            <View className="flex-row gap-3 bg-grouped-card px-4 py-2.5">
              {(
                [
                  [KIN_OUTLOOK.comingIn, view.comingIn],
                  [KIN_OUTLOOK.goingOut, view.goingOut],
                  [KIN_OUTLOOK.net, view.net],
                ] as const
              ).map(([label, lines]) => (
                <View key={label} className="min-w-0 flex-1 gap-0.5">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {label}
                  </Text>
                  {(lines.length === 0 ? [KIN_OUTLOOK.nothing] : lines).map((line) => (
                    <View key={line}>
                      <Text textRole="body" className="font-t3-bold tabular-nums text-foreground">
                        {line}
                      </Text>
                      {view.estimates.get(line) === undefined ? null : (
                        <Text textRole="footnote" className="text-foreground-muted">
                          {view.estimates.get(line)}
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          )}
          <OutlookRows
            title={KIN_OUTLOOK.comingIn}
            rows={view.incoming}
            all={all}
            more={view.more.incoming}
            onOpen={open}
          />
          <OutlookRows
            title={KIN_OUTLOOK.goingOut}
            rows={view.outgoing}
            all={all}
            more={view.more.outgoing}
            onOpen={open}
          />
          {view.notes.length + view.runway.length === 0 ? null : (
            <Text textRole="footnote" className="bg-grouped-card px-4 py-2 text-foreground-muted">
              {[...view.notes, ...view.runway.map((one) => one.text)].join(" ")}
            </Text>
          )}
          {longer ? (
            <ListActionRow
              label={all ? "Show less" : KIN_QUOTES.seeAll}
              onPress={() => setAll(!all)}
            />
          ) : null}
        </>
      )}
    </ListSection>
  );
}

// As Money counts them: no suggestion is an open quote until it is kept.
const OPEN_QUOTES = { ...KIN_LIST_DEFAULT_FILTER, show: "notClosed" as const, kept: true };

/** Open quotes first, each opening the quote; See all opens the whole list. */
export function KinQuotesSection(
  props: Section & { readonly lists: ReadonlyArray<KinListDefinition> },
) {
  if (!props.lists.some((one) => one.list === KIN_QUOTES_LIST)) return null;
  return <QuotesPeek {...props} />;
}

function QuotesPeek(props: Section) {
  const navigation = useNavigation();
  const now = new Date(useNowMinuteMs());
  const open = useOpenEntry(props);
  const { state } = useKinListEntries(props, KIN_QUOTES_LIST, OPEN_QUOTES, props.seq);
  const rows = state.records.map((record) => kinQuoteRow(record, props.rates, now));
  return (
    <KinFoldSection
      title={KIN_QUOTES.title}
      summary={state.loading && rows.length === 0 ? null : kinQuotesSummary(rows, state.total)}
    >
      {state.loading && rows.length === 0 ? (
        <Plain>Loading…</Plain>
      ) : state.failed != null && rows.length === 0 ? (
        <Plain danger>{`${KIN_QUOTES.loadFailed}.`}</Plain>
      ) : rows.length === 0 ? (
        <Plain>{KIN_QUOTES.noneOpen}</Plain>
      ) : (
        rows
          .slice(0, PEEK)
          .map((row) => (
            <Row
              key={row.key}
              label={`${row.number} · ${row.party}`}
              note={[row.stateLabel, row.when].filter(Boolean).join(" · ")}
              late={row.state === "expired"}
              amount={row.amount}
              estimate={row.estimate}
              onPress={() => open(row.key)}
            />
          ))
      )}
      <ListActionRow
        label={KIN_QUOTES.seeAll}
        onPress={() =>
          navigation.navigate("KinList", {
            environmentId: props.environmentId,
            orgId: props.orgId,
            list: KIN_QUOTES_LIST,
            filter: JSON.stringify(KIN_LIST_DEFAULT_FILTER),
          })
        }
      />
    </KinFoldSection>
  );
}

function BudgetRow(props: { readonly view: KinBudgetView; readonly onPress?: () => void }) {
  const grows = useKinTextGrows();
  const { view } = props;
  return (
    <Pressable
      accessibilityRole={props.onPress === undefined ? "text" : "button"}
      accessibilityLabel={[view.label, view.spent, view.standing, view.notCounted]
        .filter((part) => part !== null)
        .join(". ")}
      {...(props.onPress === undefined ? {} : { accessibilityHint: KIN_BUDGETS.edit })}
      disabled={props.onPress === undefined}
      onPress={props.onPress}
      className="min-h-11 gap-1.5 bg-grouped-card px-4 py-2.5 active:opacity-60"
    >
      <View className="flex-row justify-between gap-3">
        <Text
          textRole="body"
          numberOfLines={kinLines(1, grows)}
          className="min-w-0 flex-1 text-foreground"
        >
          {view.label}
        </Text>
        <Text textRole="body" className="tabular-nums text-foreground">
          {view.spent}
        </Text>
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <View
          className={cn(
            "h-full rounded-full",
            view.status === "over"
              ? "bg-danger-foreground"
              : view.status === "near"
                ? "bg-warning-foreground"
                : "bg-primary",
          )}
          style={{ width: `${Math.round(view.share * 100)}%` }}
        />
      </View>
      <Text
        textRole="footnote"
        className={view.status === "over" ? "text-danger-foreground" : "text-foreground-muted"}
      >
        {[
          view.status === "near" ? KIN_BUDGETS.near : null,
          view.standing,
          view.estimate === null ? null : `limit ${view.estimate}`,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </Text>
      {view.notCounted === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {view.notCounted}
        </Text>
      )}
    </Pressable>
  );
}

/** This month's budgets, over and near first; the owner sets, changes and removes them. */
export function KinBudgetsSection(
  props: Section & { readonly lists: ReadonlyArray<KinListDefinition> },
) {
  const navigation = useNavigation();
  const { state, refresh } = useKinBudgets(props, true);
  const canChange = useAtomValue(kinClient.workSetBudget.permissionAtom(props.environmentId));
  const [all, setAll] = useState(false);
  const expenses = props.lists.find((one) => one.list === "expenses") ?? null;
  if (state._tag === "refused" || state._tag === "gone") return null;
  const views = state._tag === "ready" ? kinBudgetsView(state.value, expenses, props.rates) : [];
  // Absent with none set: Money's Add sets the first one.
  if (state._tag === "ready" && views.length === 0) return null;
  const edit = (budget: KinMoneyBudget | null) =>
    navigation.navigate("KinBudget", {
      environmentId: String(props.environmentId),
      orgId: String(props.orgId),
      ...(budget === null ? {} : { budget: JSON.stringify(budget) }),
    });
  return (
    <KinFoldSection
      title={KIN_BUDGETS.title}
      summary={views.length === 0 ? null : kinBudgetsSummary(views)}
    >
      {state._tag === "loading" ? (
        <Plain>Loading…</Plain>
      ) : state._tag === "failed" ? (
        <KinLoadFailedRow
          title={KIN_BUDGETS.loadFailed}
          cause={state._tag === "failed" ? state.cause : null}
          onRetry={refresh}
        />
      ) : views.length === 0 ? (
        <Plain>{KIN_BUDGETS.empty}</Plain>
      ) : (
        (all ? views : views.slice(0, PEEK)).map((view) => (
          <BudgetRow
            key={view.id}
            view={view}
            {...(canChange ? { onPress: () => edit(view.budget) } : {})}
          />
        ))
      )}
      {views.length > PEEK ? (
        <ListActionRow label={all ? "Show less" : KIN_QUOTES.seeAll} onPress={() => setAll(!all)} />
      ) : null}
      {canChange && expenses !== null ? (
        <ListActionRow label={KIN_BUDGETS.add} onPress={() => edit(null)} />
      ) : null}
    </KinFoldSection>
  );
}

export type KinBudgetParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The budget being changed, as Money read it; absent for a new one. */
  readonly budget?: string;
};

const decodeBudget = Schema.decodeUnknownOption(Schema.fromJsonString(KinMoneyBudget));

/** The owner's budget form, a sheet over Money. */
export function KinBudgetScreen({ route }: StaticScreenProps<KinBudgetParams>) {
  const target = {
    environmentId: EnvironmentId.make(route.params.environmentId),
    orgId: KinOrgId.make(route.params.orgId),
  };
  const budget =
    route.params.budget === undefined ? null : Option.getOrNull(decodeBudget(route.params.budget));
  return <BudgetForm {...target} budget={budget} />;
}

function BudgetForm(props: KinWorkTarget & { readonly budget: KinMoneyBudget | null }) {
  const navigation = useNavigation();
  const { budget } = props;
  const rates = useKinRates(props);
  const lists = useKinLists(props, { enabled: true });
  const expenses = kinListsOf(lists).find((one) => one.list === "expenses") ?? null;
  const { projects } = useKinWorkChoices(props, true);
  const [draft, setDraft] = useState<KinBudgetDraft>(() => kinBudgetDraftOf(budget));
  const [requestId] = useState(uuidv4);
  const [problem, setProblem] = useState<string | null>(null);
  const setter = useKinBudgetSet(props);
  const close = () => navigation.goBack();
  const categories = expenses?.categories ?? [];
  const label = (category: string) => expenses?.categoryLabels?.[category] ?? category;
  const home = rates?.home ?? expenses?.currency ?? KIN_DEFAULT_HOME_CURRENCY;
  const save = async () => {
    const checked = kinBudgetInput(props.orgId, draft, home, requestId);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    // A changed target or currency is another budget: the old one goes, so none is left behind.
    const old = budget === null ? null : kinBudgetRemoval(props.orgId, budget, `${requestId}:old`);
    const moved =
      old !== null &&
      (old.category !== checked.input.category ||
        old.project !== checked.input.project ||
        old.currency !== checked.input.currency);
    if (!(await setter.set(checked.input))) return;
    if (moved && !(await setter.set(old))) return;
    close();
  };
  const remove = () => {
    const input = budget === null ? null : kinBudgetRemoval(props.orgId, budget, `${requestId}:rm`);
    if (input === null) return;
    Dialog.confirm({
      title: KIN_BUDGETS.removeTitle,
      message: KIN_BUDGETS.removeDetail,
      confirmText: KIN_BUDGETS.remove,
      destructive: true,
      onConfirm: () => void setter.set(input).then((ok) => (ok ? close() : undefined)),
    });
  };
  const shownProblem = problem ?? setter.problem;
  const ANY = "__any__";
  return (
    <KinWorkFrame
      form
      title={budget === null ? KIN_BUDGETS.add : KIN_BUDGETS.edit}
      onClose={close}
      confirm={{
        label: KIN_BUDGETS.save,
        loading: setter.busy,
        disabled: setter.busy,
        onPress: () => void save(),
      }}
    >
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_BUDGETS.detail}
      </Text>
      <ListSection>
        <Menu
          title={KIN_BUDGETS.category}
          accessibilityRole="button"
          accessibilityLabel={`${KIN_BUDGETS.category}: ${draft.category === null ? KIN_BUDGETS.anyCategory : label(draft.category)}. Change`}
          actions={[ANY, ...categories].map((one) => ({
            id: one,
            title: one === ANY ? KIN_BUDGETS.anyCategory : label(one),
            state: (draft.category ?? ANY) === one ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent: { event } }) =>
            setDraft({ ...draft, category: categories.find((one) => one === event) ?? null })
          }
        >
          <View pointerEvents="none">
            <ListRowLayout
              label={draft.category === null ? KIN_BUDGETS.anyCategory : label(draft.category)}
              detail={KIN_BUDGETS.category}
            />
          </View>
        </Menu>
        <KinWorkPlacePicker
          target={props}
          noun="project"
          icon="folder"
          label={KIN_BUDGETS.project}
          none={KIN_BUDGETS.anyProject}
          held={draft.project}
          choices={projects}
          disabled={setter.busy}
          onPick={(project) => setDraft({ ...draft, project })}
        />
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={KIN_BUDGETS.limit}
          value={draft.limit}
          keyboard="numbers"
          disabled={setter.busy}
          onChangeText={(limit) => setDraft({ ...draft, limit })}
        />
      </ListSection>
      {shownProblem === null ? null : <Notice message={shownProblem} tone="danger" />}
      {budget === null ? null : (
        <Button
          tone="text"
          fullWidth
          label={KIN_BUDGETS.remove}
          disabled={setter.busy}
          onPress={remove}
        />
      )}
    </KinWorkFrame>
  );
}

/** A quote's taps: sent, accepted or declined and back, its PDF, and its invoice made from it. */
export function KinQuoteActions(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    readonly quote: KinQuoteRowView;
    readonly def: KinListDefinition | null;
    readonly busy: boolean;
    readonly canChange: boolean;
    readonly onState: (state: KinRecordState) => void;
    /** Opens Make its PDF as the entry sheet's next step. */
    readonly onMakePdf: (step: KinMakeStep) => void;
  },
) {
  const { environmentId, item, quote } = props;
  const actions = useKinMoneyActions(props);
  const invoicing = useKinInvoiceFromQuote(props);
  const open = useOpenEntry(props);
  const allowed = {
    render: useAtomValue(kinClient.docRender.permissionAtom(environmentId)),
    issue: useAtomValue(kinClient.workIssue.permissionAtom(environmentId)),
    invoice: useAtomValue(kinClient.workInvoiceFromQuote.permissionAtom(environmentId)),
  };
  const invoiced = invoicing.invoice ?? kinQuoteInvoice(item.links);
  const can = kinQuoteActions(quote.state, props.def?.numbering !== undefined, invoiced !== null);
  const [requestId] = useState(uuidv4);
  const busy = props.busy || actions.busy || invoicing.busy;
  const numbered = quote.number !== item.key;
  const said = invoicing.problem ?? invoicing.notice ?? actions.problem ?? actions.notice;
  return (
    <View className="gap-2">
      {can.makeInvoice && allowed.invoice ? (
        <Button
          tone="primary"
          fullWidth
          icon="doc.text"
          label={invoicing.busy ? KIN_QUOTES.makingInvoice : KIN_QUOTES.makeInvoice}
          loading={invoicing.busy}
          disabled={busy}
          onPress={() => void invoicing.make(item.key, requestId)}
        />
      ) : null}
      {invoiced === null ? null : (
        <>
          <Text textRole="footnote" className="px-1 text-foreground-muted">
            {KIN_QUOTES.invoicedAs(invoiced)}
          </Text>
          <Button
            tone="secondary"
            fullWidth
            label={KIN_QUOTES.openInvoice}
            onPress={() => open(invoiced)}
          />
        </>
      )}
      {can.send && allowed.issue ? (
        <Button
          tone="secondary"
          fullWidth
          label={KIN_QUOTES.send}
          disabled={busy}
          onPress={() =>
            Dialog.confirm({
              title: KIN_QUOTES.sendTitle,
              message: [kinConfirmTotal(item.amount, item.party?.title), KIN_QUOTES.sendDetail]
                .filter((line) => line !== null)
                .join("\n"),
              confirmText: KIN_QUOTES.send,
              onConfirm: () => void actions.issue(item.key),
            })
          }
        />
      ) : null}
      {can.accept && props.canChange ? (
        <Button
          tone="secondary"
          fullWidth
          icon="checkmark.circle"
          label={KIN_QUOTES.accept}
          disabled={busy}
          onPress={() => props.onState("done")}
        />
      ) : null}
      {can.unaccept && props.canChange ? (
        <Button
          tone="secondary"
          fullWidth
          icon="arrow.uturn.backward"
          label={KIN_QUOTES.unaccept}
          disabled={busy}
          onPress={() => props.onState(numbered ? "waiting" : "open")}
        />
      ) : null}
      {can.undecline && allowed.issue ? (
        <Button
          tone="secondary"
          fullWidth
          icon="arrow.uturn.backward"
          label={KIN_QUOTES.undecline}
          disabled={busy}
          onPress={() => void actions.unvoid(item.key)}
        />
      ) : null}
      {quote.state !== "declined" && allowed.render ? (
        <Button
          tone="secondary"
          fullWidth
          icon="doc.text"
          label={KIN_INVOICES.makePdf}
          disabled={busy}
          onPress={() =>
            props.onMakePdf({
              list: KIN_QUOTES_LIST,
              currency: item.amount?.currency ?? props.def?.currency ?? KIN_DEFAULT_HOME_CURRENCY,
              party: item.party ?? null,
            })
          }
        />
      ) : null}
      {can.decline && allowed.issue ? (
        <Button
          tone="text"
          fullWidth
          label={KIN_QUOTES.decline}
          disabled={busy}
          onPress={() => void actions.void(item.key)}
        />
      ) : null}
      {said === null ? null : (
        <Notice
          message={said}
          tone={invoicing.problem !== null || actions.problem !== null ? "danger" : "default"}
        />
      )}
    </View>
  );
}

/** An invoice's or quote's lines, each with its SAC or HSN code, in the Make sheet. */
export function KinLinesFields(props: {
  readonly lines: ReadonlyArray<KinLineDraft>;
  readonly disabled: boolean;
  readonly onChange: (lines: ReadonlyArray<KinLineDraft>) => void;
}) {
  const set = (index: number, patch: Partial<KinLineDraft>) =>
    props.onChange(props.lines.map((one, at) => (at === index ? { ...one, ...patch } : one)));
  return (
    <>
      <View className="gap-0.5 px-2">
        <Text textRole="headline" className="text-foreground">
          {KIN_LINES.title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_LINES.detail}
        </Text>
      </View>
      {props.lines.map((line, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- lines have no id; a row is its place
        <ListSection key={index} title={`Line ${index + 1}`}>
          <KinWorkTextField
            label={KIN_LINES.description}
            value={line.description}
            maxLength={300}
            disabled={props.disabled}
            onChangeText={(description) => set(index, { description })}
          />
          <KinWorkTextField
            label={KIN_LINES.sac}
            value={line.sac}
            maxLength={8}
            keyboard="numbers"
            disabled={props.disabled}
            onChangeText={(sac) => set(index, { sac })}
          />
          <KinWorkTextField
            label={KIN_LINES.quantity}
            value={line.quantity}
            keyboard="numbers"
            disabled={props.disabled}
            onChangeText={(quantity) => set(index, { quantity })}
          />
          <KinWorkTextField
            label={KIN_LINES.unit}
            value={line.unit}
            maxLength={20}
            disabled={props.disabled}
            onChangeText={(unit) => set(index, { unit })}
          />
          <KinWorkTextField
            label={KIN_LINES.rate}
            value={line.rate}
            keyboard="numbers"
            disabled={props.disabled}
            onChangeText={(rate) => set(index, { rate })}
          />
          <ListActionRow
            label={KIN_LINES.remove}
            onPress={() => props.onChange(props.lines.filter((_, at) => at !== index))}
          />
        </ListSection>
      ))}
      <Button
        tone="secondary"
        fullWidth
        icon="plus"
        label={KIN_LINES.add}
        disabled={props.disabled}
        onPress={() => props.onChange([...props.lines, KIN_EMPTY_LINE])}
      />
    </>
  );
}
