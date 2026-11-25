import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import type { KinListOutcome } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_NUMBERS,
  kinNumberChange,
  kinNumberChart,
  kinNumberDay,
  kinNumberDraft,
  kinNumberHistory,
  kinNumberLimitsText,
  kinNumberRow,
  kinNumbersSummary,
  type KinNumberDirectionChoice,
  type KinNumberDraft,
  type KinNumberEveryChoice,
  type KinNumberLocale,
} from "@t3tools/client-runtime/kin/kinNumbers";
import type { KinNumber, KinNumberDefinition } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { KinListBanner } from "./components/KinListBanner";
import { KinLoadFailed } from "./components/KinLoadFailed";
import {
  KinFoldSection,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkTextField,
  KinWorkToggleRow,
} from "./components/KinWorkPieces";
import { FormMessage, FormShell, NO_LINK, keyParam, targetOf } from "./KinWorkFormScreens";
import { useKinHostAt } from "./state/useKinHost";
import {
  newNumberRequestId,
  useKinNumberDefinitions,
  useKinNumberLocale,
  useKinNumberRecord,
  useKinNumberSave,
  useKinNumberToday,
  useKinNumberValues,
  useKinNumbers,
  useKinNumbersShown,
} from "./state/useKinNumbers";
import type { KinWorkTarget } from "./state/useKinWork";
import { KinChart } from "./widgets/KinChart";

export type KinNumbersParams = { readonly environmentId: string; readonly orgId: string };
export type KinNumberParams = KinNumbersParams & { readonly number: string };
export type KinNumberFormParams = KinNumbersParams & { readonly number?: string };

const paramsOf = (target: KinWorkTarget) => ({
  environmentId: String(target.environmentId),
  orgId: String(target.orgId),
});

/** The row on the Chats list into Numbers: never on the dock. Absent while it isn't theirs. */
export function KinNumbersEntry(props: KinWorkTarget) {
  const navigation = useNavigation();
  const shown = useKinNumbersShown(props);
  const { state } = useKinNumbers(props, shown === true);
  if (shown !== true) return null;
  const summary =
    state._tag === "ready" ? kinNumbersSummary(state.value.numbers) : KIN_NUMBERS.title;
  const off = state._tag === "ready" && state.value.numbers.some((number) => number.off);
  return (
    <>
      <KinListBanner
        title={KIN_NUMBERS.title}
        summary={summary}
        symbol="chart.bar.xaxis"
        tone={off ? "warning" : "default"}
        accessibilityLabel={`${KIN_NUMBERS.title}. ${summary}`}
        accessibilityHint="Opens the numbers your company watches"
        onPress={() => navigation.navigate("KinNumbers", paramsOf(props))}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** Today's value typed on a row: Done saves; a refusal stays under the field with what was typed. */
function KinNumberTypeField(props: {
  readonly label: string;
  readonly placeholder?: string;
  readonly onSave: (typed: string) => Promise<KinListOutcome<unknown>>;
  readonly onSaved?: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async () => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await props.onSave(typed);
    setSaving(false);
    if (outcome.ok) {
      setTyped("");
      props.onSaved?.();
    } else setProblem(outcome.problem);
  };
  return (
    <View className="gap-1">
      <TextInput
        accessibilityLabel={props.label}
        value={typed}
        editable={!saving}
        keyboardType="numbers-and-punctuation"
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        autoCorrect={false}
        placeholder={saving ? KIN_NUMBERS.saving : (props.placeholder ?? KIN_NUMBERS.type)}
        placeholderTextColorClassName="accent-placeholder"
        onChangeText={(text) => {
          setTyped(text);
          if (problem !== null) setProblem(null);
        }}
        onSubmitEditing={() => void send()}
        className="min-h-10 rounded-lg bg-subtle px-3 font-sans text-base text-foreground"
      />
      {problem === null ? null : (
        <Text
          textRole="footnote"
          className="text-danger-foreground"
          accessibilityLiveRegion="polite"
        >
          {problem}
        </Text>
      )}
    </View>
  );
}

function Marks(props: { readonly off: boolean; readonly stale: boolean }) {
  if (!props.off && !props.stale) return null;
  return (
    <Text
      textRole="footnote"
      className={props.off ? "text-warning-foreground" : "text-foreground-muted"}
    >
      {[props.off ? KIN_NUMBERS.off : null, props.stale ? KIN_NUMBERS.stale : null]
        .filter((part) => part !== null)
        .join(" · ")}
    </Text>
  );
}

/** The Numbers place: every watched number, today's value typed on its row. */
export function KinNumbersScreen({ route }: StaticScreenProps<KinNumbersParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  return target === null ? (
    <KinWorkFrame title={KIN_NUMBERS.title} onBack={() => navigation.goBack()}>
      {NO_LINK}
    </KinWorkFrame>
  ) : (
    <KinNumbersPlace {...target} />
  );
}

function KinNumbersPlace(props: KinWorkTarget) {
  const navigation = useNavigation();
  const numbers = useKinNumbers(props);
  const host = useKinHostAt(props.environmentId);
  const connected = host._tag === "host" && host.connected;
  const today = useKinNumberToday(props, useNowMinuteMs());
  const locale = useKinNumberLocale();
  const definitions = useKinNumberDefinitions(props, numbers.canSave);
  const record = useKinNumberRecord(props);
  const { state } = numbers;
  const archived =
    definitions.state._tag === "ready"
      ? definitions.state.value.numbers.filter((definition) => definition.archived)
      : [];
  const add = () => navigation.navigate("KinNumberForm", paramsOf(props));
  const list = state._tag === "ready" ? state.value.numbers : null;
  return (
    <KinWorkFrame
      title={KIN_NUMBERS.title}
      onBack={() => navigation.goBack()}
      form
      {...(numbers.canSave && list !== null && list.length > 0
        ? { actions: [{ accessibilityLabel: KIN_NUMBERS.add, icon: "plus", onPress: add }] }
        : {})}
    >
      {state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_NUMBERS.refused} />
      ) : state._tag === "loading" ? (
        connected ? (
          <KinWorkLoading label={`Loading ${KIN_NUMBERS.title}`} />
        ) : (
          <EmptyState variant="plain" {...KIN_NUMBERS.offline} />
        )
      ) : state._tag === "failed" || state._tag === "gone" ? (
        connected ? (
          <KinLoadFailed
            title={KIN_NUMBERS.loadFailed}
            cause={state._tag === "failed" ? state.cause : null}
            onRetry={numbers.retry}
          />
        ) : (
          <EmptyState variant="plain" {...KIN_NUMBERS.offline} />
        )
      ) : list === null ? null : list.length === 0 && !numbers.ownerLevel ? (
        <EmptyState variant="plain" {...KIN_NUMBERS.refused} />
      ) : list.length === 0 ? (
        <EmptyState
          variant="plain"
          title={KIN_NUMBERS.empty.title}
          detail={`${KIN_NUMBERS.empty.detail} ${KIN_NUMBERS.empty.agent}`}
          {...(numbers.canSave
            ? { action: <Button tone="primary" label={KIN_NUMBERS.add} onPress={add} /> }
            : {})}
        />
      ) : (
        <ListSection>
          {list.map((number) => (
            <KinNumberRowView
              key={number.key}
              number={number}
              today={today}
              locale={locale}
              onOpen={() =>
                navigation.navigate("KinNumber", { ...paramsOf(props), number: number.key })
              }
              onSave={(typed) =>
                record({
                  number: number.key,
                  unit: number.unit,
                  typed,
                  asOf: today,
                  clientRequestId: newNumberRequestId(),
                })
              }
            />
          ))}
        </ListSection>
      )}
      {numbers.canSave && archived.length > 0 ? (
        <KinFoldSection
          title={KIN_NUMBERS.archived}
          summary={`${archived.length} ${KIN_NUMBERS.archived.toLowerCase()}`}
        >
          {archived.map((definition) => (
            <KinArchivedNumberRow key={definition.key} target={props} definition={definition} />
          ))}
        </KinFoldSection>
      ) : null}
    </KinWorkFrame>
  );
}

function KinNumberRowView(props: {
  readonly number: KinNumber;
  readonly today: string;
  readonly locale: KinNumberLocale;
  readonly onOpen: () => void;
  readonly onSave: (typed: string) => Promise<KinListOutcome<unknown>>;
}) {
  const row = kinNumberRow(props.number, props.today, props.locale);
  return (
    <View className="bg-grouped-card">
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={row.label}
        onPress={props.onOpen}
        className="bg-grouped-card"
      >
        <View className="gap-0.5 px-4 pt-3 pb-2">
          <Text textRole="body" className="text-foreground" numberOfLines={2}>
            {row.name}
          </Text>
          <View className="flex-row flex-wrap items-baseline gap-x-2">
            <Text
              textRole={row.value === null ? "footnote" : "headline"}
              className={cn(
                "shrink tabular-nums",
                row.value === null ? "text-foreground-muted" : "text-foreground",
              )}
              numberOfLines={2}
            >
              {row.value ?? KIN_NUMBERS.noValue}
            </Text>
            {row.asOf === null ? null : (
              <Text textRole="footnote" className="text-foreground-muted">
                {row.asOf}
              </Text>
            )}
          </View>
          <Marks off={row.off} stale={row.stale} />
        </View>
      </RowPressable>
      {row.typeToday ? (
        <View className="px-4 pb-3">
          <KinNumberTypeField label={`${KIN_NUMBERS.today}: ${row.name}`} onSave={props.onSave} />
        </View>
      ) : null}
    </View>
  );
}

const TONE = {
  good: "text-success-foreground",
  bad: "text-danger-foreground",
  plain: "text-foreground-muted",
} as const;

/** One number: its value, a static line of its days, limits, source and history with Correct. */
export function KinNumberScreen({ route }: StaticScreenProps<KinNumberParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  const key = keyParam(route.params.number);
  return target === null || key === null ? (
    <KinWorkFrame title={KIN_NUMBERS.title} onBack={() => navigation.goBack()}>
      {NO_LINK}
    </KinWorkFrame>
  ) : (
    <KinNumberPage {...target} number={key} />
  );
}

function KinNumberPage(props: KinWorkTarget & { readonly number: string }) {
  const navigation = useNavigation();
  const numbers = useKinNumbers(props);
  const today = useKinNumberToday(props, useNowMinuteMs());
  const locale = useKinNumberLocale();
  const definitions = useKinNumberDefinitions(props, numbers.canSave);
  const number =
    numbers.state._tag === "ready"
      ? (numbers.state.value.numbers.find((one) => one.key === props.number) ?? null)
      : null;
  const definition =
    definitions.state._tag === "ready"
      ? (definitions.state.value.numbers.find((one) => one.key === props.number) ?? null)
      : null;
  return (
    <KinWorkFrame
      title={number?.name ?? KIN_NUMBERS.title}
      onBack={() => navigation.goBack()}
      form
      {...(definition === null
        ? {}
        : {
            actions: [
              {
                accessibilityLabel: KIN_NUMBERS.edit,
                icon: "pencil",
                onPress: () =>
                  navigation.navigate("KinNumberForm", {
                    ...paramsOf(props),
                    number: definition.key,
                  }),
              },
            ],
          })}
    >
      {numbers.state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_NUMBERS.refused} />
      ) : numbers.state._tag === "loading" ? (
        <KinWorkLoading label={`Loading ${KIN_NUMBERS.title}`} />
      ) : numbers.state._tag === "failed" ? (
        <KinLoadFailed
          title={KIN_NUMBERS.pageFailed}
          cause={numbers.state.cause}
          onRetry={numbers.retry}
        />
      ) : number === null ? (
        <EmptyState variant="plain" title={KIN_NUMBERS.pageFailed} detail={KIN_NUMBERS.gone} />
      ) : (
        <KinNumberBody
          {...props}
          number={number}
          computed={definition?.computed ?? false}
          today={today}
          locale={locale}
        />
      )}
    </KinWorkFrame>
  );
}

function KinNumberBody(
  props: KinWorkTarget & {
    readonly number: KinNumber;
    readonly computed: boolean;
    readonly today: string;
    readonly locale: KinNumberLocale;
  },
) {
  const { number, today, locale } = props;
  const values = useKinNumberValues(props, number.key, today);
  const record = useKinNumberRecord(props);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const row = kinNumberRow(number, today, locale);
  const history = values.state._tag === "ready" ? values.state.value.values : [];
  const change = kinNumberChange(history, number, today, locale);
  const chart = kinNumberChart(number, history);
  const limits = kinNumberLimitsText(number, locale);
  const rows = kinNumberHistory(history, number.unit, today, locale);
  const save = (typed: string, asOf: string) =>
    record({
      number: number.key,
      unit: number.unit,
      typed,
      asOf,
      clientRequestId: newNumberRequestId(),
    });
  return (
    <>
      <View className="gap-1 px-1">
        <Text textRole="largeTitle" className="tabular-nums text-foreground" selectable>
          {row.value ?? KIN_NUMBERS.noValue}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {[
            number.asOf === null ? null : `as of ${kinNumberDay(number.asOf, today)}`,
            number.source === undefined ? null : `From ${number.source}`,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </Text>
        <Marks off={row.off} stale={row.stale} />
        {change === null ? null : (
          <Text textRole="body" className={TONE[change.tone]}>
            {change.text}
          </Text>
        )}
      </View>
      {row.typeToday ? (
        <KinNumberTypeField
          label={`${KIN_NUMBERS.today}: ${number.name}`}
          onSave={(typed) => save(typed, today)}
        />
      ) : null}
      {props.computed ? (
        <Text textRole="body" className="px-1 text-foreground-muted">
          {number.source === undefined
            ? KIN_NUMBERS.computedPlain
            : KIN_NUMBERS.computed(number.source)}
        </Text>
      ) : (
        <>
          {chart === null ? null : (
            <View className="rounded-xl bg-grouped-card px-4 py-3">
              <KinChart view={kinChartView(chart)} />
            </View>
          )}
          <ListSection title={KIN_NUMBERS.limits}>
            <View className="bg-grouped-card px-4 py-3">
              <Text textRole="body" className="text-foreground-muted">
                {limits ?? KIN_NUMBERS.noLimits}
              </Text>
            </View>
          </ListSection>
          <ListSection
            title={KIN_NUMBERS.history}
            {...(rows.length === 0 ? {} : { footer: KIN_NUMBERS.correctionsKept })}
          >
            {values.state._tag === "loading" ? (
              <KinWorkLoading label={`Loading ${KIN_NUMBERS.history}`} />
            ) : values.state._tag === "failed" ? (
              <KinLoadFailed
                title={KIN_NUMBERS.pageFailed}
                cause={values.state.cause}
                onRetry={values.retry}
              />
            ) : rows.length === 0 ? (
              <View className="bg-grouped-card px-4 py-3">
                <Text textRole="body" className="text-foreground-muted">
                  {KIN_NUMBERS.noHistory}
                </Text>
              </View>
            ) : (
              rows.map((entry) => (
                <View key={entry.id} className="gap-2 bg-grouped-card px-4 py-3">
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="shrink gap-0.5">
                      <Text
                        textRole="body"
                        className={cn(
                          "tabular-nums",
                          entry.replaced ? "text-foreground-muted line-through" : "text-foreground",
                        )}
                      >
                        {entry.value}
                      </Text>
                      <Text textRole="footnote" className="text-foreground-muted">
                        {[entry.day, entry.by, entry.replaced ? KIN_NUMBERS.replaced : null]
                          .filter((part) => part !== null)
                          .join(" · ")}
                      </Text>
                    </View>
                    {number.canType && !entry.replaced ? (
                      <Button
                        tone="secondary"
                        size="compact"
                        label={KIN_NUMBERS.correct}
                        accessibilityLabel={KIN_NUMBERS.correctOf(entry.day)}
                        onPress={() => setCorrecting(correcting === entry.id ? null : entry.id)}
                      />
                    ) : null}
                  </View>
                  {correcting === entry.id ? (
                    <KinNumberTypeField
                      label={KIN_NUMBERS.correctOf(entry.day)}
                      placeholder={KIN_NUMBERS.typeCorrection}
                      onSave={(typed) => save(typed, entry.asOf)}
                      onSaved={() => setCorrecting(null)}
                    />
                  ) : null}
                </View>
              ))
            )}
          </ListSection>
        </>
      )}
    </>
  );
}

const DIRECTIONS = Object.keys(KIN_NUMBERS.directions) as ReadonlyArray<KinNumberDirectionChoice>;
const EVERIES = Object.keys(KIN_NUMBERS.everies) as ReadonlyArray<KinNumberEveryChoice>;

/** Watch a number, or change, archive or restore one, as a sheet. */
export function KinNumberFormScreen({ route }: StaticScreenProps<KinNumberFormParams>) {
  const target = targetOf(route.params);
  const key = keyParam(route.params.number);
  const title = route.params.number === undefined ? KIN_NUMBERS.add : KIN_NUMBERS.edit;
  if (target === null || (route.params.number !== undefined && key === null))
    return <FormMessage title={title}>{NO_LINK}</FormMessage>;
  return <KinNumberFormRead {...target} numberKey={key} title={title} />;
}

function KinNumberFormRead(
  props: KinWorkTarget & { readonly numberKey: string | null; readonly title: string },
) {
  const definitions = useKinNumberDefinitions(props, true);
  if (props.numberKey === null)
    return <KinNumberForm target={props} definition={null} title={props.title} />;
  if (definitions.state._tag === "refused")
    return (
      <FormMessage title={props.title}>
        <EmptyState variant="plain" {...KIN_NUMBERS.refused} />
      </FormMessage>
    );
  if (definitions.state._tag !== "ready")
    return (
      <FormMessage title={props.title}>
        <KinWorkLoading label={`Loading ${KIN_NUMBERS.title}`} />
      </FormMessage>
    );
  const definition =
    definitions.state.value.numbers.find((one) => one.key === props.numberKey) ?? null;
  if (definition === null) return <FormMessage title={props.title}>{NO_LINK}</FormMessage>;
  return <KinNumberForm target={props} definition={definition} title={props.title} />;
}

function KinNumberForm(props: {
  readonly target: KinWorkTarget;
  readonly definition: KinNumberDefinition | null;
  readonly title: string;
}) {
  const navigation = useNavigation();
  const { definition } = props;
  const locale = useKinNumberLocale();
  const save = useKinNumberSave(props.target);
  const [requestId] = useState(newNumberRequestId);
  const [draft, setDraft] = useState<KinNumberDraft>(() => kinNumberDraft(definition, locale));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const edit = (patch: Partial<KinNumberDraft>) => setDraft({ ...draft, ...patch });
  const send = async (archived?: boolean) => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await save({
      definition,
      draft,
      clientRequestId: archived === undefined ? requestId : newNumberRequestId(),
      ...(archived === undefined ? {} : { archived }),
    });
    setSaving(false);
    if (!outcome.ok) setProblem(outcome.problem);
    // An archived number's page has nothing left to show: back to the list it left.
    else if (archived === true)
      navigation.dispatch(StackActions.popTo("KinNumbers", paramsOf(props.target)));
    else navigation.goBack();
  };
  const optional = KIN_NUMBERS.form.optional;
  return (
    <FormShell
      title={props.title}
      submit={definition === null ? KIN_NUMBERS.add : KIN_NUMBERS.save}
      saving={saving}
      canSave={draft.name.trim() !== ""}
      problem={problem === null ? null : { kind: "failed", text: problem }}
      onSave={() => void send()}
    >
      <ListSection>
        <KinWorkTextField
          label={KIN_NUMBERS.form.name}
          value={draft.name}
          autoFocus={definition === null}
          disabled={saving}
          maxLength={200}
          placeholder={KIN_NUMBERS.form.namePlaceholder}
          onChangeText={(name) => edit({ name })}
        />
        <KinWorkTextField
          label={KIN_NUMBERS.form.unit}
          value={draft.unit}
          disabled={saving}
          maxLength={40}
          keyboard="plain"
          placeholder={KIN_NUMBERS.form.unitPlaceholder}
          hint={optional}
          onChangeText={(unit) => edit({ unit })}
        />
      </ListSection>
      <ListSection title={KIN_NUMBERS.form.direction}>
        {DIRECTIONS.map((direction) => (
          <ListChoiceRow
            key={direction}
            label={KIN_NUMBERS.directions[direction]}
            selected={draft.direction === direction}
            disabled={saving}
            onPress={() => edit({ direction })}
          />
        ))}
      </ListSection>
      <ListSection title={KIN_NUMBERS.form.every}>
        {EVERIES.map((every) => (
          <ListChoiceRow
            key={every}
            label={KIN_NUMBERS.everies[every]}
            selected={draft.every === every}
            disabled={saving}
            onPress={() => edit({ every })}
          />
        ))}
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={KIN_NUMBERS.form.above}
          value={draft.above}
          keyboard="numbers"
          disabled={saving}
          hint={optional}
          onChangeText={(above) => edit({ above })}
        />
        <KinWorkTextField
          label={KIN_NUMBERS.form.below}
          value={draft.below}
          keyboard="numbers"
          disabled={saving}
          hint={optional}
          onChangeText={(below) => edit({ below })}
        />
        <KinWorkTextField
          label={KIN_NUMBERS.form.source}
          value={draft.source}
          disabled={saving}
          maxLength={240}
          placeholder={KIN_NUMBERS.form.sourcePlaceholder}
          hint={optional}
          onChangeText={(source) => edit({ source })}
        />
      </ListSection>
      {definition?.computed === true ? null : (
        <ListSection>
          <KinWorkToggleRow
            label={KIN_NUMBERS.share}
            value={draft.shared}
            disabled={saving}
            onValueChange={(shared) => edit({ shared })}
          />
        </ListSection>
      )}
      {definition === null ? null : (
        <ListSection>
          {definition.archived ? (
            <ListActionRow
              icon="arrow.uturn.backward"
              label={KIN_NUMBERS.restore}
              disabled={saving}
              onPress={() => void send(false)}
            />
          ) : (
            <ListActionRow
              icon="archivebox"
              tone="danger"
              label={KIN_NUMBERS.archive}
              disabled={saving}
              onPress={() => void send(true)}
            />
          )}
        </ListSection>
      )}
    </FormShell>
  );
}

/** An archived number in the fold: Restore brings it back as it was, in one press. */
function KinArchivedNumberRow(props: {
  readonly target: KinWorkTarget;
  readonly definition: KinNumberDefinition;
}) {
  const save = useKinNumberSave(props.target);
  const locale = useKinNumberLocale();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const restore = async () => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await save({
      definition: props.definition,
      draft: kinNumberDraft(props.definition, locale),
      clientRequestId: newNumberRequestId(),
      archived: false,
    });
    setSaving(false);
    if (!outcome.ok) setProblem(outcome.problem);
  };
  return (
    <View>
      <ListActionRow
        label={`${KIN_NUMBERS.restore} ${props.definition.name}`}
        icon="arrow.uturn.backward"
        onPress={() => void restore()}
      />
      {problem === null ? null : (
        <Text
          textRole="footnote"
          className="px-4 pb-2 text-danger-foreground"
          accessibilityLiveRegion="polite"
        >
          {problem}
        </Text>
      )}
    </View>
  );
}
