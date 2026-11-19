import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DEALS,
  kinDealChangeText,
  kinDealNext,
  kinDealNextStage,
  kinDealPill,
  kinDealStageName,
  kinDealStrip,
  kinDealWhen,
} from "@t3tools/client-runtime/kin/kinDeals";
import { kinMoneyText, kinParseMoney } from "@t3tools/client-runtime/kin/kinLists";
import { kinWorkAllDay, kinWorkDueText, kinWorkName } from "@t3tools/client-runtime/kin/kinWork";
import type {
  KinDealMove,
  KinDealPage as KinDealPageValue,
  KinDealRow,
  KinRecordKey,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  TrophyIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { randomUUID } from "../lib/utils";
import { kinClient } from "./kinClient";
import { KinDealLostDialog, KinDealMoveMenu, KinDealNextLine } from "./KinDeals";
import { Field, FormShell } from "./KinWorkForms";
import {
  KinLoadFailed,
  KinWorkNotice,
  KinWorkPrivateMark,
  KinWorkRowSkeletons,
  KinWorkSection,
} from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinDealPage, useKinDealSend } from "./useKinDeals";
import { useKinInvoiceFromQuote } from "./useKinMoneyAnswers";
import { useKinHomeCurrency } from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

type DealPageProps = KinWorkTarget & {
  readonly dealKey: KinRecordKey;
  readonly frame: "sheet" | "pane" | "page";
  readonly directory: KinWorkDirectory;
  readonly onOpenTask: (key: KinRecordKey) => void;
  readonly onOpenClient: (key: KinRecordKey) => void;
  /** Opens a new project already for this client; null where projects can't be added. */
  readonly onStartProject: ((party: { key: KinRecordKey; title: string }) => void) | null;
  readonly onClose: () => void;
};

const focusOnMount = (node: HTMLElement | null) => node?.focus({ preventScroll: true });

/** One deal: its stage and moves, value, next step, details and what happened to it. */
export function KinDealPage(props: DealPageProps) {
  const { state, refresh } = useKinDealPage(props, props.dealKey);
  return (
    <div
      ref={focusOnMount}
      tabIndex={-1}
      aria-label={props.dealKey}
      role="region"
      className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto outline-none"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        event.preventDefault();
        props.onClose();
      }}
    >
      {state._tag === "loading" ? (
        <div className="p-4" role="status" aria-label="Loading deal">
          <KinWorkRowSkeletons />
        </div>
      ) : state._tag === "gone" || state._tag === "refused" ? (
        <KinWorkNotice title={KIN_DEALS.title} detail={KIN_DEALS.gone} />
      ) : state._tag === "failed" ? (
        <KinLoadFailed
          what={KIN_DEALS.loadFailed}
          cause={state.cause}
          onRetry={refresh}
          className="p-4"
        />
      ) : (
        <DealBody {...props} page={state.value} />
      )}
      {props.frame === "page" ? null : (
        <div className="absolute end-2 top-2">
          <Button size="icon" variant="ghost" aria-label="Close deal" onClick={props.onClose}>
            <XIcon />
          </Button>
        </div>
      )}
    </div>
  );
}

const PILL = { open: "info", won: "success", lost: "error" } as const;

function DealBody(props: DealPageProps & { readonly page: KinDealPageValue }) {
  const { page, directory } = props;
  const { deal, stages } = page;
  const names = directory.names;
  const now = new Date(useNowMinuteMs());
  const send = useKinDealSend(props);
  const invoice = useKinInvoiceFromQuote(props);
  const canInvoice = useAtomValue(
    kinClient.workInvoiceFromQuote.permissionAtom(props.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [losing, setLosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [becameClient, setBecameClient] = useState(false);
  const [requestId] = useState(randomUUID);

  const move = async (to: KinDealMove) => {
    setBusy(true);
    setProblem(null);
    const outcome = await send.move(deal, to);
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    if (outcome.value.becameClient === true) setBecameClient(true);
    setLosing(false);
  };
  const nextStage = kinDealNextStage(deal, stages);
  const when = kinDealWhen(deal, names, now);
  const next = kinDealNext(deal, names, now);
  const lastStage = kinDealStageName(stages, deal.stage);

  return (
    <div className="flex flex-col gap-5 p-4 pe-12">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={PILL[deal.state]}>{kinDealPill(deal, stages)}</Badge>
          <span className="text-xs text-muted-foreground">{deal.key}</span>
          {deal.sensitive ? <KinWorkPrivateMark /> : null}
        </div>
        <h2 className="text-lg font-medium text-foreground">{deal.title}</h2>
        <p className="flex flex-wrap items-baseline gap-2">
          {deal.value === undefined ? null : (
            <span className="text-2xl font-medium tabular-nums">{kinMoneyText(deal.value)}</span>
          )}
          {when === null ? null : <span className="text-sm text-muted-foreground">{when}</span>}
        </p>
      </div>

      {deal.state !== "open" ? null : (
        <ol
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
          aria-label={KIN_DEALS.stage}
        >
          {kinDealStrip(deal, stages).map((step) => (
            <li
              key={step.id}
              className="flex min-w-0 flex-col gap-1"
              aria-current={step.current ? "step" : undefined}
            >
              <span
                className={
                  step.reached ? "h-1 rounded-full bg-primary" : "h-1 rounded-full bg-border"
                }
              />
              <span
                className={
                  step.current
                    ? "truncate text-xs font-medium text-foreground"
                    : "truncate text-xs text-muted-foreground"
                }
              >
                {step.name}
              </span>
            </li>
          ))}
        </ol>
      )}

      {!deal.can.move ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {deal.state === "open" ? (
            <>
              {nextStage === null ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void move({ _tag: "stage", stage: nextStage.id })}
                >
                  <ArrowRightIcon />
                  {KIN_DEALS.moveToStage(nextStage.name)}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void move({ _tag: "won" })}
              >
                <TrophyIcon />
                {KIN_DEALS.won}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setLosing(true)}>
                <XIcon />
                {KIN_DEALS.lost}
              </Button>
              <KinDealMoveMenu
                deal={deal}
                stages={stages}
                disabled={busy}
                onMove={(to) => void move(to)}
                onLost={() => setLosing(true)}
              />
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void move({ _tag: "reopen" })}
            >
              <RotateCcwIcon />
              {KIN_DEALS.reopen}
            </Button>
          )}
          {!deal.can.edit ? null : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <PencilIcon />
              Edit
            </Button>
          )}
        </div>
      )}

      {problem === null || losing ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {deal.state === "open" && deal.quote?.accepted === true && deal.can.move ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          <p className="min-w-0 flex-1 text-sm">{KIN_DEALS.quoteAcceptedHint(deal.quote.title)}</p>
          <Button size="sm" disabled={busy} onClick={() => void move({ _tag: "won" })}>
            <TrophyIcon />
            {KIN_DEALS.markWon}
          </Button>
        </section>
      ) : null}

      {deal.state === "won" &&
      (props.onStartProject !== null || (canInvoice && deal.quote !== undefined)) ? (
        <section
          aria-label={KIN_DEALS.won}
          className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
        >
          <p className="text-sm text-foreground">
            {becameClient ? `${KIN_DEALS.becameClient(deal.party.title)} ` : ""}
            {KIN_DEALS.whatNext}
          </p>
          <div className="flex flex-wrap gap-2">
            {props.onStartProject === null ? null : (
              <Button
                size="sm"
                onClick={() =>
                  props.onStartProject?.({ key: deal.party.key, title: deal.party.title })
                }
              >
                <PlusIcon />
                {KIN_DEALS.startProject}
              </Button>
            )}
            {!canInvoice || deal.quote === undefined ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={invoice.busy}
                aria-busy={invoice.busy}
                onClick={() => {
                  if (deal.quote !== undefined) void invoice.make(deal.quote.key, requestId);
                }}
              >
                {KIN_DEALS.invoiceFrom(deal.quote.title)}
              </Button>
            )}
          </div>
          {invoice.problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{invoice.problem}</AlertDescription>
            </Alert>
          )}
          {invoice.invoice === null ? null : (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{invoice.notice}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => invoice.invoice !== null && props.onOpenTask(invoice.invoice)}
              >
                Open {invoice.invoice}
              </Button>
            </div>
          )}
        </section>
      ) : null}

      {deal.state === "lost" && deal.lostReason !== undefined ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-foreground">{KIN_DEALS.lostWhy(deal.lostReason)}</p>
        </section>
      ) : null}

      {deal.state !== "open" ? null : (
        <KinWorkSection title={KIN_DEALS.nextStep}>
          {page.steps.length === 0 ? (
            <KinDealNextLine next={next} />
          ) : (
            <ul className="-mx-2 flex flex-col">
              {page.steps.map((step) => {
                const due = kinWorkDueText(
                  { dueAt: step.dueAt, dueAllDay: step.dueAllDay },
                  names,
                  now,
                );
                return (
                  <li key={step.key}>
                    <button
                      type="button"
                      onClick={() => props.onOpenTask(step.key)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                    >
                      <span
                        className={
                          step.late
                            ? "min-w-0 flex-1 truncate text-destructive-foreground"
                            : "min-w-0 flex-1 truncate"
                        }
                      >
                        {step.late ? KIN_DEALS.late(step.title) : step.title}
                      </span>
                      {due === null ? null : (
                        <span className="text-xs text-muted-foreground">{due}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {deal.can.edit ? <AddStep {...props} deal={deal} onProblem={setProblem} /> : null}
        </KinWorkSection>
      )}

      <KinWorkSection title={KIN_DEALS.details}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{KIN_DEALS.clientField}</dt>
          <dd>
            <button
              type="button"
              className="text-start text-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:underline"
              onClick={() => props.onOpenClient(deal.party.key)}
            >
              {deal.party.title}
            </button>
          </dd>
          <dt className="text-muted-foreground">{KIN_DEALS.lookedAfterBy}</dt>
          <dd>{kinWorkName(deal.owner, names)}</dd>
          {deal.state === "open" && next !== null ? (
            <>
              <dt className="text-muted-foreground">{KIN_DEALS.nextStep}</dt>
              <dd>{deal.next?.title ?? KIN_DEALS.noNextStep}</dd>
            </>
          ) : null}
          {deal.source === undefined ? null : (
            <>
              <dt className="text-muted-foreground">{KIN_DEALS.cameFrom}</dt>
              <dd>{deal.source}</dd>
            </>
          )}
          {deal.quote === undefined ? null : (
            <>
              <dt className="text-muted-foreground">{KIN_DEALS.quote}</dt>
              <dd>
                <button
                  type="button"
                  className="text-start text-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:underline"
                  onClick={() => deal.quote !== undefined && props.onOpenTask(deal.quote.key)}
                >
                  {deal.quote.accepted
                    ? KIN_DEALS.quoteAccepted(deal.quote.title)
                    : deal.quote.title}
                </button>
              </dd>
            </>
          )}
          {deal.state !== "lost" || lastStage === null ? null : (
            <>
              <dt className="text-muted-foreground">{KIN_DEALS.lastStage}</dt>
              <dd>{lastStage}</dd>
            </>
          )}
        </dl>
        {page.notes === "" ? null : (
          <p className="whitespace-pre-wrap text-sm text-foreground">{page.notes}</p>
        )}
      </KinWorkSection>

      {page.changes.length === 0 ? null : (
        <KinWorkSection title={KIN_DEALS.activity}>
          <ul className="flex flex-col gap-1.5 text-sm">
            {page.changes.map((change) => (
              <li key={change.seq} className="flex gap-2">
                <span className="min-w-0 flex-1 text-foreground">
                  {kinDealChangeText(change, names, now)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {kinWorkDueText({ dueAt: change.at, dueAllDay: false }, names, now)}
                </span>
              </li>
            ))}
          </ul>
        </KinWorkSection>
      )}

      {!losing ? null : (
        <KinDealLostDialog
          title={deal.title}
          busy={busy}
          problem={problem}
          onLost={(reason) => void move({ _tag: "lost", reason })}
          onClose={() => {
            setLosing(false);
            setProblem(null);
          }}
        />
      )}
      {!editing ? null : <DealEdit {...props} deal={deal} onClose={() => setEditing(false)} />}
    </div>
  );
}

function AddStep(
  props: KinWorkTarget & {
    readonly deal: KinDealRow;
    readonly onProblem: (problem: string) => void;
  },
) {
  const send = useKinDealSend(props);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(randomUUID);
  const id = useId();
  if (!open)
    return (
      <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(true)}>
        <PlusIcon />
        {KIN_DEALS.addStep}
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (title.trim() === "") return;
        setBusy(true);
        const outcome = await send.step(
          props.deal.key,
          { title: title.trim(), ...(day === "" ? {} : { dueAt: day, dueAllDay: true }) },
          requestId,
        );
        setBusy(false);
        if (!outcome.ok) return props.onProblem(outcome.problem);
        setTitle("");
        setDay("");
        setRequestId(randomUUID());
        setOpen(false);
      }}
    >
      <label htmlFor={id} className="sr-only">
        {KIN_DEALS.nextStep}
      </label>
      <Input
        id={id}
        autoFocus
        className="min-w-48 flex-1"
        maxLength={280}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Input
        type="date"
        aria-label="Next step's day"
        className="w-40"
        value={day}
        onChange={(event) => setDay(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={busy || title.trim() === ""} aria-busy={busy}>
        {KIN_DEALS.addStep}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </form>
  );
}

/** Title, value, expected day, came from and the quote's key. */
function DealEdit(
  props: KinWorkTarget & {
    readonly deal: KinDealRow;
    readonly directory: KinWorkDirectory;
    readonly onClose: () => void;
  },
) {
  const { deal } = props;
  const send = useKinDealSend(props);
  const home = useKinHomeCurrency(props) ?? deal.value?.currency ?? "USD";
  const [title, setTitle] = useState(deal.title);
  const [value, setValue] = useState(deal.value === undefined ? "" : kinMoneyText(deal.value));
  const [expected, setExpected] = useState(
    kinWorkAllDay(deal.expectedAt, deal.expectedAllDay, props.directory.names) ?? "",
  );
  const [source, setSource] = useState(deal.source ?? "");
  const [quote, setQuote] = useState<string>(deal.quote?.key ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = {
    title: useId(),
    value: useId(),
    expected: useId(),
    source: useId(),
    quote: useId(),
  };
  const money = value.trim() === "" ? null : kinParseMoney(value, home);
  const moneyBad = value.trim() !== "" && money === null;
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await send.update({
      key: deal.key,
      rev: deal.rev,
      ...(title.trim() === deal.title ? {} : { title: title.trim() }),
      value: money,
      expectedOn: expected === "" ? null : expected,
      source: source.trim() === "" ? null : source.trim(),
      ...(quote.trim() === (deal.quote?.key ?? "")
        ? {}
        : { quote: quote.trim() === "" ? null : (quote.trim() as KinRecordKey) }),
    });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    props.onClose();
  };
  return (
    <FormShell
      title={`Edit ${deal.key}`}
      submit="Save"
      saving={busy}
      canSave={title.trim() !== "" && !moneyBad}
      problem={problem === null ? null : { kind: "invalid", text: problem }}
      onOpenExisting={() => {}}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <Field id={ids.title} label={KIN_DEALS.what}>
        <Input
          id={ids.title}
          maxLength={280}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          id={ids.value}
          label={KIN_DEALS.value}
          hint={moneyBad ? KIN_DEALS.notAmount : KIN_DEALS.valueHint}
        >
          <Input
            id={ids.value}
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Field id={ids.expected} label={KIN_DEALS.expected}>
          <Input
            id={ids.expected}
            type="date"
            value={expected}
            onChange={(event) => setExpected(event.target.value)}
          />
        </Field>
      </div>
      <Field id={ids.source} label={KIN_DEALS.cameFrom}>
        <Input
          id={ids.source}
          maxLength={120}
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
      </Field>
      <Field
        id={ids.quote}
        label={KIN_DEALS.quote}
        hint="The quote's number, like QT-17. It must be for the same client."
      >
        <Input id={ids.quote} value={quote} onChange={(event) => setQuote(event.target.value)} />
      </Field>
    </FormShell>
  );
}
