import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import {
  KIN_NUMBERS,
  kinNumberChange,
  kinNumberChart,
  kinNumberDay,
  kinNumberDraft,
  kinNumberHistory,
  kinNumberLimitsText,
  kinNumberRow,
  type KinNumberLocale,
} from "@t3tools/client-runtime/kin/kinNumbers";
import type {
  EnvironmentId,
  KinNumber,
  KinNumberDefinition,
  KinOrgId,
  KinRecordKey,
} from "@t3tools/contracts";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { hasDesktopWindowChrome } from "./kinDesktopWindow";
import { KinChart } from "./KinChart";
import { KinNumberForm } from "./KinNumberForm";
import { KinNumberTypeField } from "./KinNumberTypeField";
import { KinLoadFailed, KinWorkNotice, KinWorkRowSkeletons, KinWorkSection } from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinHostAt } from "./useKinHost";
import {
  newNumberRequestId,
  useKinNumberDefinitions,
  useKinNumberLocale,
  useKinNumberRecord,
  useKinNumberSave,
  useKinNumberToday,
  useKinNumberValues,
  useKinNumbers,
} from "./useKinNumbers";
import type { KinWorkTarget } from "./useKinWork";

type Editing = KinNumberDefinition | "new" | null;

/** The Numbers place: every watched number, and one number's page when `number` is open. */
export function KinNumbersView(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly number: KinRecordKey | null;
  readonly onOpen: (number: KinRecordKey | null) => void;
}) {
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const numbers = useKinNumbers(target);
  const host = useKinHostAt(props.environmentId);
  const connected = host._tag === "host" && host.connected;
  const today = useKinNumberToday(target, useNowMinuteMs());
  const locale = useKinNumberLocale();
  const definitions = useKinNumberDefinitions(target, numbers.canSave);
  const [editing, setEditing] = useState<Editing>(null);
  const { state } = numbers;
  const list = state._tag === "ready" ? state.value.numbers : null;
  const opened =
    props.number === null ? null : (list?.find((number) => number.key === props.number) ?? null);
  const held = definitions.state._tag === "ready" ? definitions.state.value.numbers : ([] as const);
  const definitionOf = (key: string) => held.find((definition) => definition.key === key) ?? null;
  const archived = held.filter((definition) => definition.archived);
  const add =
    numbers.canSave && list !== null && list.length > 0 ? (
      <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
        <PlusIcon />
        {KIN_NUMBERS.add}
      </Button>
    ) : null;
  const header = (
    <WorkspacePageHeader electron={hasDesktopWindowChrome}>
      {props.number === null ? null : (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={KIN_NUMBERS.back}
          onClick={() => props.onOpen(null)}
        >
          <ArrowLeftIcon />
        </Button>
      )}
      <WorkspaceBreadcrumb ariaLabel={KIN_NUMBERS.title}>
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">{opened?.name ?? KIN_NUMBERS.title}</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto flex items-center gap-1">
        {opened !== null && definitionOf(opened.key) !== null ? (
          <Button size="sm" variant="outline" onClick={() => setEditing(definitionOf(opened.key))}>
            {KIN_NUMBERS.edit}
          </Button>
        ) : props.number === null ? (
          add
        ) : null}
      </div>
    </WorkspacePageHeader>
  );
  const body =
    state._tag === "refused" ? (
      <KinWorkNotice {...KIN_NUMBERS.refused} />
    ) : state._tag === "loading" && !connected ? (
      <KinWorkNotice {...KIN_NUMBERS.offline} />
    ) : state._tag === "loading" ? (
      <div role="status" aria-label={`Loading ${KIN_NUMBERS.title}`}>
        <KinWorkRowSkeletons />
      </div>
    ) : state._tag === "failed" || state._tag === "gone" ? (
      connected ? (
        <KinLoadFailed
          what={KIN_NUMBERS.loadFailed}
          cause={state._tag === "failed" ? state.cause : null}
          onRetry={numbers.retry}
        />
      ) : (
        <KinWorkNotice {...KIN_NUMBERS.offline} />
      )
    ) : props.number !== null ? (
      opened === null ? (
        <KinWorkNotice title={KIN_NUMBERS.pageFailed} detail={KIN_NUMBERS.gone} />
      ) : (
        <KinNumberPage
          {...target}
          number={opened}
          computed={definitionOf(opened.key)?.computed ?? false}
          today={today}
          locale={locale}
        />
      )
    ) : list === null ? null : list.length === 0 && !numbers.ownerLevel ? (
      <KinWorkNotice {...KIN_NUMBERS.refused} />
    ) : list.length === 0 ? (
      <KinNumbersEmpty canAdd={numbers.canSave} onAdd={() => setEditing("new")} />
    ) : (
      <KinNumbersList
        {...target}
        numbers={list}
        today={today}
        locale={locale}
        onOpen={(key) => props.onOpen(key)}
      />
    );
  return (
    <>
      {header}
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
          {body}
          {props.number === null && numbers.canSave && archived.length > 0 ? (
            <KinWorkSection
              title={KIN_NUMBERS.archived}
              fold={{ summary: `${archived.length} ${KIN_NUMBERS.archived.toLowerCase()}` }}
            >
              <ul className="flex flex-col gap-1">
                {archived.map((definition) => (
                  <KinArchivedNumberRow key={definition.key} {...target} definition={definition} />
                ))}
              </ul>
            </KinWorkSection>
          ) : null}
        </div>
      </div>
      {editing === null ? null : (
        <KinNumberForm
          {...target}
          definition={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            if (saved.archived && props.number === saved.key) props.onOpen(null);
          }}
        />
      )}
    </>
  );
}

function KinNumbersEmpty(props: { readonly canAdd: boolean; readonly onAdd: () => void }) {
  return (
    <KinWorkNotice
      title={KIN_NUMBERS.empty.title}
      detail={`${KIN_NUMBERS.empty.detail} ${KIN_NUMBERS.empty.agent}`}
      {...(props.canAdd
        ? {
            action: (
              <Button size="sm" onClick={props.onAdd}>
                <PlusIcon />
                {KIN_NUMBERS.add}
              </Button>
            ),
          }
        : {})}
    />
  );
}

/** A quiet mark beside a value: outside its limit, or not updated lately. */
function KinNumberMarks(props: { readonly off: boolean; readonly stale: boolean }) {
  return (
    <>
      {props.off ? (
        <Badge size="sm" variant="warning">
          {KIN_NUMBERS.off}
        </Badge>
      ) : null}
      {props.stale ? (
        <Badge size="sm" variant="secondary">
          {KIN_NUMBERS.stale}
        </Badge>
      ) : null}
    </>
  );
}

function KinNumbersList(
  props: KinWorkTarget & {
    readonly numbers: ReadonlyArray<KinNumber>;
    readonly today: string;
    readonly locale: KinNumberLocale;
    readonly onOpen: (key: KinRecordKey) => void;
  },
) {
  const record = useKinNumberRecord(props);
  return (
    <ul className="flex flex-col divide-y divide-border">
      {props.numbers.map((number) => {
        const row = kinNumberRow(number, props.today, props.locale);
        return (
          <li
            key={number.key}
            className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:gap-4"
          >
            <button
              type="button"
              aria-label={row.label}
              onClick={() => props.onOpen(number.key)}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm text-foreground">{row.name}</span>
                <KinNumberMarks off={row.off} stale={row.stale} />
              </span>
              <span className="flex min-w-0 items-baseline gap-2">
                <span
                  className={cn(
                    "min-w-0 truncate tabular-nums",
                    row.value === null
                      ? "text-xs text-muted-foreground"
                      : "text-base font-medium text-foreground",
                  )}
                >
                  {row.value ?? KIN_NUMBERS.noValue}
                </span>
                {row.asOf === null ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground">{row.asOf}</span>
                )}
              </span>
            </button>
            {row.typeToday ? (
              <div className="px-2 sm:px-0">
                <KinNumberTypeField
                  name={number.name}
                  onSave={(typed) =>
                    record({
                      number: number.key,
                      unit: number.unit,
                      typed,
                      asOf: props.today,
                      clientRequestId: newNumberRequestId(),
                    })
                  }
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const TONE = {
  good: "text-success-foreground",
  bad: "text-destructive-foreground",
  plain: "text-muted-foreground",
} as const;

/** One number: its latest value, a static line of its days, its limits, source and history. */
function KinNumberPage(
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
  const history = values.state._tag === "ready" ? values.state.value.values : ([] as const);
  const change = kinNumberChange(history, number, today, locale);
  const chart = kinNumberChart(number, history);
  const limits = kinNumberLimitsText(number, locale);
  const rows = kinNumberHistory(history, number.unit, today, locale);
  const sourceLine = number.source === undefined ? null : `From ${number.source}`;
  const save = (typed: string, asOf: string) =>
    record({
      number: number.key,
      unit: number.unit,
      typed,
      asOf,
      clientRequestId: newNumberRequestId(),
    });
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 break-words text-3xl font-semibold tabular-nums text-foreground">
            {row.value ?? KIN_NUMBERS.noValue}
          </p>
          <KinNumberMarks off={row.off} stale={row.stale} />
        </div>
        <p className="text-xs text-muted-foreground">
          {[number.asOf === null ? null : `as of ${kinNumberDay(number.asOf, today)}`, sourceLine]
            .filter((part) => part !== null)
            .join(" · ")}
        </p>
        {change === null ? null : <p className={cn("text-sm", TONE[change.tone])}>{change.text}</p>}
      </section>
      {row.typeToday ? (
        <KinNumberTypeField name={number.name} onSave={(typed) => save(typed, today)} />
      ) : null}
      {props.computed ? (
        <p className="text-sm text-muted-foreground">
          {number.source === undefined
            ? KIN_NUMBERS.computedPlain
            : KIN_NUMBERS.computed(number.source)}
        </p>
      ) : (
        <>
          {chart === null ? null : <KinChart view={kinChartView(chart)} />}
          <KinWorkSection title={KIN_NUMBERS.limits}>
            <p className="text-sm text-muted-foreground">{limits ?? KIN_NUMBERS.noLimits}</p>
          </KinWorkSection>
          <KinWorkSection title={KIN_NUMBERS.history}>
            {values.state._tag === "loading" ? (
              <KinWorkRowSkeletons />
            ) : values.state._tag === "failed" ? (
              <KinLoadFailed
                what={KIN_NUMBERS.pageFailed}
                cause={values.state.cause}
                onRetry={values.retry}
              />
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{KIN_NUMBERS.noHistory}</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{KIN_NUMBERS.correctionsKept}</p>
                <ol className="flex flex-col divide-y divide-border">
                  {rows.map((entry) => (
                    <li key={entry.id} className="flex flex-col gap-2 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span
                            className={cn(
                              "break-words text-sm tabular-nums",
                              entry.replaced
                                ? "text-muted-foreground line-through"
                                : "text-foreground",
                            )}
                          >
                            {entry.value}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {[entry.day, entry.by, entry.replaced ? KIN_NUMBERS.replaced : null]
                              .filter((part) => part !== null)
                              .join(" · ")}
                          </span>
                        </div>
                        {number.canType && !entry.replaced ? (
                          <Button
                            size="xs"
                            variant="outline"
                            aria-label={KIN_NUMBERS.correctOf(entry.day)}
                            aria-expanded={correcting === entry.id}
                            onClick={() => setCorrecting(correcting === entry.id ? null : entry.id)}
                          >
                            {KIN_NUMBERS.correct}
                          </Button>
                        ) : null}
                      </div>
                      {correcting === entry.id ? (
                        <KinNumberTypeField
                          name={number.name}
                          label={KIN_NUMBERS.correctOf(entry.day)}
                          placeholder={KIN_NUMBERS.typeCorrection}
                          onSave={(typed) => save(typed, entry.asOf)}
                          onSaved={() => setCorrecting(null)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </KinWorkSection>
        </>
      )}
    </div>
  );
}

/** An archived number in the fold: Restore brings it back as it was, in one press. */
function KinArchivedNumberRow(props: KinWorkTarget & { readonly definition: KinNumberDefinition }) {
  const save = useKinNumberSave(props);
  const locale = useKinNumberLocale();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const restore = async () => {
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
    <li className="flex flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {props.definition.name}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={saving}
          aria-label={`${KIN_NUMBERS.restore} ${props.definition.name}`}
          onClick={() => void restore()}
        >
          {KIN_NUMBERS.restore}
        </Button>
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </li>
  );
}
