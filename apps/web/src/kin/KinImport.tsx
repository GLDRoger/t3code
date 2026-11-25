import {
  KIN_IMPORT,
  KIN_IMPORT_DATE_FORMATS,
  KIN_IMPORT_NO_CHOICES,
  KIN_IMPORT_TARGET_LABELS,
  KIN_IMPORT_TARGETS,
  kinImportBase64,
  kinImportCheckButton,
  kinImportChooseClient,
  kinImportChooseStage,
  kinImportClientChoice,
  kinImportCurrencies,
  kinImportCloseName,
  kinImportDecisions,
  kinImportDoneLine,
  kinImportFileLine,
  kinImportKeptLine,
  kinImportLeftOutLine,
  kinImportMatchedBy,
  kinImportMoreLine,
  kinImportNeedsLook,
  kinImportNoticed,
  kinImportOwnersLine,
  kinImportProgress,
  kinImportReady,
  kinImportRunLine,
  kinImportRunningByLine,
  kinImportRunningLine,
  kinImportRunningOf,
  kinImportStageChoice,
  kinImportStageLine,
  kinImportStagePick,
  kinImportStoppedLines,
  kinImportTiles,
  kinImportTooBig,
  kinImportUndoneLine,
  kinImportUndoneLines,
  kinImportWriting,
  type KinImportChoices,
} from "@t3tools/client-runtime/kin/kinImport";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type {
  KinImportApplied,
  KinImportCheck,
  KinImportClientDecision,
  KinImportFile,
  KinImportMapping,
  KinImportTarget,
  KinImportUndone,
} from "@t3tools/contracts";
import { FileTextIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { KinLoadFailed, KinWorkRowSkeletons } from "./KinWorkParts";
import { useKinImportRuns, useKinImportSend } from "./useKinImport";
import type { KinWorkTarget } from "./useKinWork";

type Busy = { readonly doing: "reading" | "checking" | "importing"; readonly rows: number };
type Picked = KinImportFile & { readonly size: number };

/** One small picker: a column's destination, a decision, a stage, a currency or a day format. */
function Pick(props: {
  readonly label: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select value={props.value ?? ""} onValueChange={(value) => props.onChange(String(value))}>
      <SelectTrigger aria-label={props.label} size="sm" className="w-48 min-w-0">
        <SelectValue>
          {props.options.find((one) => one.id === props.value)?.label ?? props.placeholder ?? ""}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {props.options.map((one) => (
          <SelectItem key={one.id} value={one.id}>
            {one.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Steps(props: { readonly at: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {KIN_IMPORT.steps.map((name, index) => (
        <li
          key={name}
          aria-current={index === props.at ? "step" : undefined}
          className={index === props.at ? "font-semibold text-foreground" : undefined}
        >
          {index + 1} {name}
          {index < KIN_IMPORT.steps.length - 1 ? <span className="ms-2">›</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Clients, Add, Import a file: pick a file, see where its columns go, check it and decide what
 * Kin can't, import it, and take it away again. The owner level only; the host decides too.
 */
export function KinImportView(
  props: KinWorkTarget & {
    readonly directory: KinWorkNames;
    /** Null while Deals is off, or not this person's. */
    readonly onOpenDeals: (() => void) | null;
  },
) {
  const host = useKinImportSend(props);
  const { state: runs, refresh: rereadRuns } = useKinImportRuns(props);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [checked, setChecked] = useState<KinImportCheck | null>(null);
  const [mapping, setMapping] = useState<KinImportMapping | null>(null);
  const [choices, setChoices] = useState<KinImportChoices>(KIN_IMPORT_NO_CHOICES);
  const [applied, setApplied] = useState<KinImportApplied | null>(null);
  const [undone, setUndone] = useState<KinImportUndone | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const writing = useRef(false);
  const nameOf = (personId: string) => props.directory.people.get(personId) ?? "Someone";
  const step = applied !== null ? 3 : checked?.checked === true ? 2 : checked !== null ? 1 : 0;

  const send = async (
    file: KinImportFile,
    nextMapping: KinImportMapping | undefined,
    nextChoices: KinImportChoices,
    rows: number,
  ) => {
    setProblem(null);
    setBusy({ doing: nextMapping === undefined ? "reading" : "checking", rows });
    const outcome = await host.check({
      file: { name: file.name, data: file.data },
      ...(nextMapping === undefined ? {} : { mapping: nextMapping }),
      decisions: kinImportDecisions(nextChoices),
    });
    setBusy(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    setChecked(outcome.value);
    setMapping(outcome.value.mapping);
  };

  const choose = async (file: File) => {
    const tooBig = kinImportTooBig(file.size);
    if (tooBig !== null) return setProblem(tooBig);
    setBusy({ doing: "reading", rows: 0 });
    const data = kinImportBase64(new Uint8Array(await file.arrayBuffer()));
    const next = { name: file.name.slice(0, 200), data, size: file.size };
    setPicked(next);
    setChoices(KIN_IMPORT_NO_CHOICES);
    setApplied(null);
    setUndone(null);
    await send(next, undefined, KIN_IMPORT_NO_CHOICES, 0);
  };

  const recheck = (next: KinImportMapping) => {
    setMapping(next);
    if (picked !== null && checked !== null) void send(picked, next, choices, checked.rows);
  };

  const importNow = async () => {
    // A second press before the first re-renders would otherwise send the file twice.
    if (picked === null || checked === null || mapping === null || writing.current) return;
    writing.current = true;
    setProblem(null);
    setBusy({ doing: "importing", rows: checked.rows });
    const outcome = await host.apply({
      file: { name: picked.name, data: picked.data },
      mapping,
      decisions: kinImportDecisions(choices),
      batch: checked.batch,
    });
    writing.current = false;
    setBusy(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    setApplied(outcome.value);
  };

  const undoBatch = async (batch: string) => {
    if (writing.current) return;
    writing.current = true;
    setProblem(null);
    setUndoing(batch);
    const outcome = await host.undo(batch);
    writing.current = false;
    setUndoing(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    setUndone(outcome.value);
  };

  const startOver = () => {
    setPicked(null);
    setChecked(null);
    setMapping(null);
    setApplied(null);
    setUndone(null);
    setChoices(KIN_IMPORT_NO_CHOICES);
  };

  // The host's own count of each run, live on the imports topic; this screen's own runs first.
  const running = runs._tag === "ready" ? runs.value.running : undefined;
  const mine =
    busy?.doing === "checking"
      ? kinImportRunningOf(running, "check", checked?.batch ?? null)
      : busy?.doing === "importing"
        ? kinImportRunningOf(running, "apply", checked?.batch ?? null)
        : undoing !== null
          ? kinImportRunningOf(running, "undo", undoing)
          : null;
  const others = (running ?? []).filter((one) => one !== mine);
  // Someone's import or undo, or this one's from before a reload: a second waits for it.
  const othersWriting = kinImportWriting(others);
  const mineLine = mine === null ? null : kinImportRunningLine(mine);
  const status = (
    <>
      {busy !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {mineLine ?? kinImportProgress(busy.doing, busy.rows)}
        </p>
      ) : undoing !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {mineLine ?? KIN_IMPORT.undoing}
        </p>
      ) : null}
      {others.map((one) => (
        <p
          key={`${one.action}:${one.batch}:${one.by}:${one.at}`}
          role="status"
          className="text-sm text-muted-foreground"
        >
          {kinImportRunningByLine(one, nameOf(one.by))}
        </p>
      ))}
    </>
  );
  const problemLine =
    problem === null ? null : (
      <p role="alert" className="text-sm text-destructive-foreground">
        {problem}
      </p>
    );
  const undoneBlock =
    undone === null ? null : (
      <section aria-label={KIN_IMPORT.undone} className="flex flex-col gap-1 text-sm">
        {kinImportUndoneLines(undone).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </section>
    );

  const earlier = (
    <section aria-label={KIN_IMPORT.earlier} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{KIN_IMPORT.earlier}</h3>
      {runs._tag === "loading" ? (
        <KinWorkRowSkeletons />
      ) : runs._tag === "failed" ? (
        <KinLoadFailed what={KIN_IMPORT.earlier} cause={null} onRetry={rereadRuns} />
      ) : runs._tag === "refused" ? (
        <p className="text-sm text-muted-foreground">{KIN_IMPORT.onlyOwner}</p>
      ) : runs._tag === "gone" || runs.value.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_IMPORT.noneEarlier}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.value.runs.map((run) => {
            const why = kinImportUndoneLine(run, nameOf);
            return (
              <li
                key={run.batch}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  {kinImportRunLine(run, nameOf(run.by))}
                  {kinImportStoppedLines(run).map((line) => (
                    <span key={line} className="block text-xs text-muted-foreground">
                      {line}
                    </span>
                  ))}
                </span>
                {why === null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={undoing !== null || busy !== null || othersWriting}
                    onClick={() => void undoBatch(run.batch)}
                  >
                    {KIN_IMPORT.undo}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">{why}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  const fileStep = (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{KIN_IMPORT.title}</h2>
        <p className="text-sm text-muted-foreground">{KIN_IMPORT.intro}</p>
      </div>
      <div
        data-over={over}
        className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm data-[over=true]:bg-accent"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const file = event.dataTransfer.files[0];
          if (file !== undefined) void choose(file);
        }}
      >
        <UploadIcon className="size-5" aria-hidden />
        <p>
          {KIN_IMPORT.drop}{" "}
          <Button
            variant="link"
            size="xs"
            disabled={busy !== null}
            onClick={() => input.current?.click()}
          >
            {KIN_IMPORT.choose}
          </Button>
        </p>
        <p className="text-xs text-muted-foreground">{KIN_IMPORT.limits}</p>
        <input
          ref={input}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          aria-label={KIN_IMPORT.chooseFile}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void choose(file);
          }}
        />
      </div>
      {status}
      {problemLine}
      {undoneBlock}
      {earlier}
    </div>
  );

  const columnsStep =
    checked === null || mapping === null || picked === null ? null : (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">{kinImportFileLine(picked.name, checked.rows)}</h2>
          <p className="text-sm text-muted-foreground">{KIN_IMPORT.columnsIntro}</p>
        </div>
        <ul aria-label={KIN_IMPORT.goesTo} className="flex flex-col divide-y divide-border text-sm">
          <li className="hidden gap-3 pb-2 text-xs text-muted-foreground sm:grid sm:grid-cols-[10rem_12rem_auto_1fr]">
            <span>{KIN_IMPORT.yourColumn}</span>
            <span>{KIN_IMPORT.firstValue}</span>
            <span>{KIN_IMPORT.goesTo}</span>
          </li>
          {checked.columns
            .map((column, at) => ({ ...column, at }))
            .map((column) => {
              const index = column.at;
              const target = mapping.columns[index] ?? "skip";
              return (
                <li
                  key={`column-${column.at}`}
                  className="flex flex-col gap-1 py-2 sm:grid sm:grid-cols-[10rem_12rem_auto_1fr] sm:items-center sm:gap-3"
                >
                  <span className="font-medium">{column.header || KIN_IMPORT.unnamed}</span>
                  <span className="truncate text-muted-foreground">{column.sample}</span>
                  <Pick
                    label={`${column.header} ${KIN_IMPORT.goesTo}`}
                    value={target}
                    options={KIN_IMPORT_TARGETS.map((id) => ({
                      id,
                      label: KIN_IMPORT_TARGET_LABELS[id],
                    }))}
                    onChange={(value) =>
                      setMapping({
                        ...mapping,
                        columns: mapping.columns.map((one, at) =>
                          at === index ? (value as KinImportTarget) : one,
                        ),
                      })
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {column.note ?? (target === "client.kind" ? KIN_IMPORT.kindHint : "")}
                  </span>
                </li>
              );
            })}
        </ul>
        {status}
        {problemLine}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={startOver} disabled={busy !== null}>
            {KIN_IMPORT.back}
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => void send(picked, mapping, choices, checked.rows)}
          >
            {kinImportCheckButton(checked.rows)}
          </Button>
        </div>
      </div>
    );

  const clientOptions = (candidates: ReadonlyArray<{ key: string; name: string }>) => [
    ...candidates.map((one) => ({ id: one.key, label: `${KIN_IMPORT.sameCompany}: ${one.name}` })),
    { id: "new", label: KIN_IMPORT.newOne },
    { id: "skip", label: KIN_IMPORT.leaveOut },
  ];
  const checkStep =
    checked === null || mapping === null || picked === null ? null : (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{KIN_IMPORT.whatWillHappen}</h2>
        {checked.asks.currency || checked.asks.dateFormat || mapping.currency !== undefined ? (
          <div className="flex flex-col gap-2 text-sm">
            {checked.asks.currency || mapping.currency !== undefined ? (
              <label className="flex flex-wrap items-center gap-2">
                {KIN_IMPORT.currencyAsk}
                <Pick
                  label={KIN_IMPORT.currencyAsk}
                  value={mapping.currency ?? null}
                  placeholder={KIN_IMPORT.currencyPick}
                  options={kinImportCurrencies(checked.homeCurrency).map((id) => ({
                    id,
                    label: id,
                  }))}
                  onChange={(value) => recheck({ ...mapping, currency: value })}
                />
              </label>
            ) : null}
            {checked.asks.dateFormat || mapping.dateFormat !== undefined ? (
              <label className="flex flex-wrap items-center gap-2">
                {KIN_IMPORT.dateAsk} {checked.asks.dateExamples.join(", ")}{" "}
                {KIN_IMPORT.dateAskAfter}
                <Pick
                  label={KIN_IMPORT.dateAsk}
                  value={mapping.dateFormat ?? null}
                  placeholder={KIN_IMPORT.decide}
                  options={KIN_IMPORT_DATE_FORMATS}
                  onChange={(value) =>
                    recheck({ ...mapping, dateFormat: value === "mdy" ? "mdy" : "dmy" })
                  }
                />
              </label>
            ) : null}
          </div>
        ) : null}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {kinImportTiles(checked).map((tile) => (
            <li key={tile.id} className="rounded-lg border border-border px-3 py-2">
              <p
                className={
                  tile.alert
                    ? "text-xl font-semibold text-warning-foreground"
                    : "text-xl font-semibold"
                }
              >
                {tile.value.toLocaleString("en-US")}
              </p>
              <p className="text-xs text-muted-foreground">{tile.label}</p>
            </li>
          ))}
        </ul>
        {checked.matches.length + checked.decide.length === 0 ? null : (
          <section aria-label={KIN_IMPORT.matchesTitle} className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                {KIN_IMPORT.matchesTitle} · {checked.matched + checked.decide.length}
              </h3>
              <p className="text-xs text-muted-foreground">{KIN_IMPORT.matchesHint}</p>
            </div>
            <ul className="flex flex-col divide-y divide-border">
              {checked.matches.map((match) => (
                <li
                  key={match.source}
                  className="flex flex-col gap-1 py-2 sm:grid sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center sm:gap-3"
                >
                  <span>{match.name}</span>
                  <span className="font-medium">{match.existing}</span>
                  <span className="text-muted-foreground">
                    {kinImportMatchedBy(match)}
                    {match.kept.length === 0 ? null : (
                      <span className="block text-xs">{kinImportKeptLine(match.kept)}</span>
                    )}
                  </span>
                  <Pick
                    label={`${match.name} ${KIN_IMPORT.matchedBy}`}
                    value={kinImportClientChoice(checked, choices, match.source)}
                    options={[
                      { id: "same", label: KIN_IMPORT.sameCompany },
                      { id: "skip", label: KIN_IMPORT.leaveOut },
                    ]}
                    onChange={(value) =>
                      setChoices(
                        kinImportChooseClient(
                          choices,
                          match.source,
                          value as KinImportClientDecision,
                        ),
                      )
                    }
                  />
                </li>
              ))}
              {checked.decide.map((near) => (
                <li
                  key={near.source}
                  className="flex flex-col gap-1 py-2 sm:grid sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center sm:gap-3"
                >
                  <span>{near.name}</span>
                  <span className="font-medium">
                    {near.candidates.map((one) => one.name).join(", ")}
                  </span>
                  <span className="text-muted-foreground">{kinImportCloseName}</span>
                  <Pick
                    label={`${near.name} ${KIN_IMPORT.decide}`}
                    value={kinImportClientChoice(checked, choices, near.source)}
                    placeholder={KIN_IMPORT.decide}
                    options={clientOptions(near.candidates)}
                    onChange={(value) =>
                      setChoices(
                        kinImportChooseClient(
                          choices,
                          near.source,
                          value as KinImportClientDecision,
                        ),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
        {kinImportNeedsLook(checked) === 0 ? null : (
          <section aria-label={KIN_IMPORT.needLook} className="flex flex-col gap-2 text-sm">
            <h3 className="font-semibold">
              {KIN_IMPORT.needLook} · {kinImportNeedsLook(checked)}
            </h3>
            {checked.stages.map((stage) => (
              <div key={stage.value} className="flex flex-wrap items-center gap-2">
                <TriangleAlertIcon className="size-4 text-warning-foreground" aria-hidden />
                <span>{kinImportStageLine(stage)}</span>
                <Pick
                  label={kinImportStageLine(stage)}
                  value={kinImportStageChoice(checked, choices, stage.value)}
                  placeholder={KIN_IMPORT.decide}
                  options={[
                    ...checked.companyStages.map((one) => ({
                      id: one.id,
                      label: kinImportStagePick(one),
                    })),
                    { id: "skip", label: KIN_IMPORT.leaveOut },
                  ]}
                  onChange={(value) =>
                    setChoices(kinImportChooseStage(choices, stage.value, value))
                  }
                />
              </div>
            ))}
            {checked.ownersUnknown === 0 ? null : (
              <p className="flex items-center gap-2">
                <TriangleAlertIcon className="size-4 text-warning-foreground" aria-hidden />
                {kinImportOwnersLine(checked.ownersUnknown)}
              </p>
            )}
          </section>
        )}
        {checked.leftOut.length + checked.notImported.length === 0 ? null : (
          <section aria-label={KIN_IMPORT.leftOut} className="flex flex-col gap-1 text-sm">
            <h3 className="font-semibold">{KIN_IMPORT.leftOut}</h3>
            {checked.notImported.map((one) => (
              <p key={one.header} className="text-muted-foreground">
                {one.header}: {one.reason}
              </p>
            ))}
            {checked.leftOut.slice(0, 50).map((one) => (
              <p key={`${one.line}:${one.reason}`} className="text-muted-foreground">
                {kinImportLeftOutLine(one)}
              </p>
            ))}
            {kinImportMoreLine(checked.more + Math.max(0, checked.leftOut.length - 50)) ?? null}
          </section>
        )}
        {status}
        {problemLine}
        {kinImportReady(checked, choices) ? null : (
          <p className="text-sm text-muted-foreground">{KIN_IMPORT.decideFirst}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => setChecked({ ...checked, checked: false })}
          >
            {KIN_IMPORT.back}
          </Button>
          <Button
            disabled={busy !== null || othersWriting || !kinImportReady(checked, choices)}
            onClick={() => void importNow()}
          >
            {KIN_IMPORT.import}
          </Button>
        </div>
      </div>
    );

  const doneStep =
    applied === null ? null : (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">{KIN_IMPORT.imported}</h2>
          <p className="text-sm text-muted-foreground">{kinImportDoneLine(applied)}</p>
        </div>
        {kinImportNoticed(applied).length === 0 ? null : (
          <section
            aria-label={KIN_IMPORT.noticed}
            className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2 text-sm"
          >
            <h3 className="font-semibold">{KIN_IMPORT.noticed}</h3>
            {kinImportNoticed(applied).map((line) => (
              <p key={line} className="flex items-start gap-2">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                {line}
              </p>
            ))}
          </section>
        )}
        {applied.leftOut.length === 0 ? null : (
          <section aria-label={KIN_IMPORT.leftOut} className="flex flex-col gap-1 text-sm">
            <h3 className="font-semibold">{KIN_IMPORT.leftOut}</h3>
            {applied.leftOut.slice(0, 50).map((one) => (
              <p key={`${one.line}:${one.reason}`} className="text-muted-foreground">
                {kinImportLeftOutLine(one)}
              </p>
            ))}
            {kinImportMoreLine(applied.more + Math.max(0, applied.leftOut.length - 50)) ?? null}
          </section>
        )}
        {status}
        {problemLine}
        {undoneBlock}
        <div className="flex flex-wrap gap-2">
          {applied.added.deals === 0 || props.onOpenDeals === null ? null : (
            <Button onClick={props.onOpenDeals}>{KIN_IMPORT.openDeals}</Button>
          )}
          {undone === null ? (
            <Button
              variant="outline"
              disabled={undoing !== null || othersWriting}
              onClick={() => void undoBatch(applied.batch)}
            >
              {KIN_IMPORT.undo}
            </Button>
          ) : (
            <Button variant="outline" onClick={startOver}>
              {KIN_IMPORT.another}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{KIN_IMPORT.undoAfter}</p>
      </div>
    );

  return (
    <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
        <Steps at={step} />
        {step === 0 ? fileStep : step === 1 ? columnsStep : step === 2 ? checkStep : doneStep}
      </div>
    </div>
  );
}
