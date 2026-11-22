import { useAtomValue } from "@effect/atom-react";
import { KIN_DEFAULT_HOME_CURRENCY } from "@t3tools/contracts";
import type { KinRates } from "@t3tools/client-runtime/kin/kinCurrency";
import { KIN_BANK, KIN_LIST_DEFAULT_FILTER } from "@t3tools/client-runtime/kin/kinLists";
import type { KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
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
  type KinOutlookView,
  kinQuoteRow,
  kinQuotesSummary,
  kinBudgetsSummary,
  type KinBudgetDraft,
  type KinBudgetView,
  type KinLineDraft,
  type KinOutlookRowView,
} from "@t3tools/client-runtime/kin/kinMoneyAnswers";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  type KinListDefinition,
  type KinMoneyBudget,
  KinPersonId,
  type KinRecordKey,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import { Skeleton } from "../components/ui/skeleton";
import { cn, randomUUID } from "../lib/utils";
import { kinClient } from "./kinClient";
import { KinPlaceCombobox } from "./KinPlaceCombobox";
import { KinWorkSection } from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { kinListsOf, useKinAskAgent, useKinListEntries, type KinListsHandle } from "./useKinMoney";
import {
  useKinBudgets,
  useKinBudgetSet,
  useKinCash,
  useKinMatchPartner,
  useKinOutlook,
} from "./useKinMoneyAnswers";
import { useKinWorkChoices, useKinWorkDirectory, type KinWorkTarget } from "./useKinWork";

const OPENS =
  "rounded-md outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";
const PEEK = 5;

type Section = KinWorkTarget & { readonly seq: number | null; readonly rates: KinRates | null };

function Loading(props: { readonly label: string }) {
  return (
    <div role="status" aria-label={props.label} className="flex flex-col gap-2 px-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function Failed(props: { readonly text: string; readonly onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
      <span>{props.text}.</span>
      <Button size="xs" variant="ghost" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** A name and its note on the left; one amount and its "about ₹x" on the right. */
function Row(props: {
  readonly label: string;
  readonly note?: string | null;
  readonly late?: boolean;
  readonly amount: string | null;
  readonly estimate?: string | null;
  readonly onOpen?: () => void;
  readonly children?: React.ReactNode;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-foreground">{props.label}</span>
        {props.note == null || props.note === "" ? null : (
          <span
            className={cn(
              "truncate text-xs",
              props.late ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {props.note}
          </span>
        )}
        {props.children}
      </span>
      {props.amount === null ? null : (
        <span className="flex shrink-0 flex-col items-end text-sm text-foreground tabular-nums">
          {props.amount}
          {props.estimate == null ? null : (
            <span className="text-xs text-muted-foreground">{props.estimate}</span>
          )}
        </span>
      )}
    </>
  );
  const shape = "flex w-full items-start gap-3 px-2 py-1.5 text-start";
  return props.onOpen === undefined ? (
    <div className={shape}>{body}</div>
  ) : (
    <button type="button" onClick={props.onOpen} className={cn(shape, OPENS)}>
      {body}
    </button>
  );
}

/** Bank balances of record, one line each; why a figure is held back sits behind Why. */
export function KinCashSection(props: Section) {
  const now = new Date(useNowMinuteMs());
  const { state, refresh } = useKinCash(props, true);
  const agent = useKinAskAgent(props);
  const [why, setWhy] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  if (state._tag === "refused" || state._tag === "gone") return null;
  const view = state._tag === "ready" ? kinCashView(state.value, props.rates, now) : null;
  const detailed = view !== null && (view.currencies.length > 0 || view.notCounted.length > 0);
  return (
    <KinWorkSection
      title={KIN_CASH.title}
      action={
        detailed ? (
          <Button size="xs" variant="ghost" onClick={() => setDetails(!details)}>
            {details ? KIN_CASH.hideWhy : KIN_CASH.details}
          </Button>
        ) : undefined
      }
    >
      {state._tag === "loading" ? (
        <Loading label={`Loading ${KIN_CASH.title}`} />
      ) : view === null ? (
        <Failed text={KIN_CASH.loadFailed} onRetry={refresh} />
      ) : (
        <div className="flex flex-col gap-2">
          {view.known ? null : (
            <p className="px-2 text-sm text-muted-foreground">{KIN_CASH.none}</p>
          )}
          <ul className="flex flex-col">
            {view.accounts.map((one) => (
              <li key={one.id}>
                <Row
                  label={one.label}
                  note={[one.when, one.flag].filter((part) => part !== null).join(" · ")}
                  late={one.stale || one.flag !== null}
                  amount={one.amount}
                  estimate={one.estimate}
                >
                  {one.notes.length === 0 ? null : why === one.id ? (
                    <span className="flex flex-col gap-0.5 pt-0.5">
                      {one.notes.map((note) => (
                        <span key={note} className="text-xs text-muted-foreground">
                          {note}
                        </span>
                      ))}
                      <Button
                        size="xs"
                        variant="ghost"
                        className="self-start"
                        onClick={() => setWhy(null)}
                      >
                        {KIN_CASH.hideWhy}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="self-start"
                      onClick={() => setWhy(one.id)}
                    >
                      {KIN_CASH.why}
                    </Button>
                  )}
                </Row>
              </li>
            ))}
          </ul>
          {view.bank === null && agent === null ? null : (
            <div className="flex flex-wrap items-center gap-x-2 px-2">
              {view.bank === null ? null : (
                <span className="text-xs text-muted-foreground">{view.bank}</span>
              )}
              {agent === null ? null : (
                <Button size="xs" variant="ghost" onClick={() => agent.ask(KIN_BANK.uploadMessage)}>
                  {KIN_BANK.upload}
                </Button>
              )}
            </div>
          )}
          {view.currencies.map((one) => (
            <div key={one.currency} className="flex flex-col gap-1 px-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">{one.totalLabel}</span>
                <span className="flex flex-col items-end tabular-nums">
                  <span className="font-medium text-foreground">
                    {one.total ?? KIN_CASH.withheld}
                  </span>
                  {one.totalEstimate === null ? null : (
                    <span className="text-xs text-muted-foreground">{one.totalEstimate}</span>
                  )}
                </span>
              </div>
              {one.estimate === null ? null : (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {KIN_CASH.estimate}
                    <Badge size="sm" variant="outline">
                      Estimate
                    </Badge>
                  </span>
                  <span className="flex flex-col items-end text-foreground tabular-nums">
                    {one.estimate}
                    {one.estimateAbout === null ? null : (
                      <span className="text-xs text-muted-foreground">{one.estimateAbout}</span>
                    )}
                  </span>
                </div>
              )}
              {details ? (
                <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  <span>{one.recordedLabel}</span>
                  <span className="tabular-nums">
                    {KIN_CASH.in} {one.received} · {KIN_CASH.out} {one.spent}
                  </span>
                  {one.estimate === null ? null : <span>{KIN_CASH.estimateNote}</span>}
                </div>
              ) : null}
            </div>
          ))}
          {!details || view.notCounted.length === 0 ? null : (
            <div className="flex flex-col gap-0.5 px-2">
              <span className="text-xs font-medium text-muted-foreground">
                {KIN_CASH.notCounted}
              </span>
              {view.notCounted.map((one) => (
                <span key={one.id} className="text-xs text-muted-foreground">
                  {one.text}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </KinWorkSection>
  );
}

function OutlookRows(props: {
  readonly title: string;
  readonly rows: ReadonlyArray<KinOutlookRowView>;
  readonly all: boolean;
  readonly more: number;
  readonly onOpenKey: (key: KinRecordKey) => void;
}) {
  if (props.rows.length === 0 || !props.all) return null;
  const shown = props.rows;
  return (
    <div className="flex flex-col">
      <span className="px-2 text-xs text-muted-foreground">{props.title}</span>
      <ul className="flex flex-col">
        {shown.map((row) => (
          <li key={row.id}>
            <Row
              label={row.title}
              note={row.note}
              amount={row.amount}
              estimate={row.estimate}
              {...(row.key === null ? {} : { onOpen: () => props.onOpenKey(row.key!) })}
            />
          </li>
        ))}
      </ul>
      {props.all && props.more > 0 ? (
        <p className="px-2 text-xs text-muted-foreground">{KIN_OUTLOOK.more(props.more)}</p>
      ) : null}
    </div>
  );
}

/** Who the company owes back; one no teammate is matched to yet gets a person picked. */
function PartnersOwed(
  props: Section & {
    readonly rows: KinOutlookView["partners"];
    readonly unsaid: KinOutlookView["unsaid"];
  },
) {
  const directory = useKinWorkDirectory(
    props,
    props.rows.some((one) => one.match !== null) || props.unsaid.length > 0,
  );
  const matching = useKinMatchPartner(props);
  const [saying, setSaying] = useState<KinOutlookView["unsaid"][number] | null>(null);
  const people = [...directory.names.people].toSorted((a, b) => a[1].localeCompare(b[1]));
  if (props.rows.length + props.unsaid.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {props.rows.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="px-2 text-xs text-muted-foreground">{KIN_OUTLOOK.partners}</span>
          <ul className="flex flex-col">
            {props.rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-2 py-1">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-foreground">{row.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{row.note}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {row.match === null ? null : (
                    <Select
                      value={null}
                      disabled={matching.busy}
                      onValueChange={(personId) => {
                        if (typeof personId === "string")
                          void matching.match(
                            row.match!.address,
                            row.match!.seen,
                            KinPersonId.make(personId),
                          );
                      }}
                    >
                      <SelectTrigger size="sm" aria-label={`${KIN_OUTLOOK.whoIsThis} ${row.name}`}>
                        <SelectValue>{KIN_OUTLOOK.whoIsThis}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {people.map(([id, name]) => (
                          <SelectItem key={id} value={id}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                  <span className="text-sm font-medium text-foreground tabular-nums">
                    {row.amount}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.unsaid.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="px-2 text-xs text-muted-foreground">{KIN_OUTLOOK.unsaid}</span>
          <ul className="flex flex-col">
            {props.unsaid.map((row) => (
              <li
                key={row.address}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-1"
              >
                <span className="flex min-w-0 flex-1 basis-56 flex-col">
                  <span className="truncate text-sm text-foreground">{row.address}</span>
                  <span className="text-xs text-muted-foreground">{row.note}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={matching.busy}
                    onClick={() => setSaying(row)}
                  >
                    {KIN_OUTLOOK.sayWho}
                  </Button>
                  <span className="text-sm font-medium text-foreground tabular-nums">
                    {row.amount}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {matching.problem === null || saying !== null ? null : (
        <p className="px-2 text-xs text-destructive">{matching.problem}</p>
      )}
      {saying === null ? null : (
        <SayWhoPaid
          row={saying}
          people={people}
          busy={matching.busy}
          problem={matching.problem}
          onSay={async (personId, settled) => {
            if (await matching.match(saying.address, saying.seen, personId, settled))
              setSaying(null);
          }}
          onClose={() => setSaying(null)}
        />
      )}
    </div>
  );
}

/** The owner's word on an imported address: who it was, and whether the company still owes them. */
function SayWhoPaid(props: {
  readonly row: KinOutlookView["unsaid"][number];
  readonly people: ReadonlyArray<readonly [string, string]>;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSay: (personId: KinPersonId, settled: "owed" | "repaid") => Promise<void>;
  readonly onClose: () => void;
}) {
  const [personId, setPersonId] = useState<string | null>(null);
  const [settled, setSettled] = useState<"owed" | "repaid" | null>(null);
  const ids = { person: useId(), settled: useId() };
  const ready = personId !== null && settled !== null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) void props.onSay(KinPersonId.make(personId), settled);
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-all">
              {KIN_OUTLOOK.sayTitle(props.row.address)}
            </DialogTitle>
            <DialogDescription>
              {KIN_OUTLOOK.sayDetail(props.row.expenses, props.row.amount)}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.person}>{KIN_OUTLOOK.paidBy}</Label>
                <Select
                  value={personId}
                  disabled={props.busy}
                  onValueChange={(value) => setPersonId(typeof value === "string" ? value : null)}
                >
                  <SelectTrigger id={ids.person}>
                    <SelectValue>
                      {(value: string | null) =>
                        props.people.find(([id]) => id === value)?.[1] ?? KIN_OUTLOOK.pickPerson
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {props.people.map(([id, name]) => (
                      <SelectItem key={id} value={id}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <span id={ids.settled} className="text-sm font-medium text-foreground">
                  {KIN_OUTLOOK.settledQuestion}
                </span>
                <RadioGroup
                  aria-labelledby={ids.settled}
                  value={settled ?? ""}
                  disabled={props.busy}
                  onValueChange={(value) => setSettled(value === "owed" ? "owed" : "repaid")}
                >
                  {(
                    [
                      ["owed", KIN_OUTLOOK.stillOwed, KIN_OUTLOOK.stillOwedHint],
                      ["repaid", KIN_OUTLOOK.paidBack, KIN_OUTLOOK.paidBackHint],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-accent"
                    >
                      <span className="mt-0.5 flex">
                        <Radio value={value} />
                      </span>
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm text-foreground">{label}</span>
                        <span className="text-xs text-muted-foreground">{hint}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </div>
              {props.problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{props.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={props.busy} onClick={props.onClose}>
              {KIN_WORK_COPY.cancel}
            </Button>
            <Button type="submit" disabled={!ready || props.busy} aria-busy={props.busy}>
              {props.busy ? KIN_OUTLOOK.saving : KIN_OUTLOOK.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** What is expected in and out over the next 30 days, by currency, and runway. */
export function KinOutlookSection(
  props: Section & { readonly onOpenKey: (key: KinRecordKey) => void },
) {
  const now = new Date(useNowMinuteMs());
  const { state, refresh } = useKinOutlook(props, true);
  const [all, setAll] = useState(false);
  if (state._tag === "refused" || state._tag === "gone") return null;
  const view = state._tag === "ready" ? kinOutlookView(state.value, props.rates, now) : null;
  const longer = view !== null && view.incoming.length + view.outgoing.length > 0;
  return (
    <KinWorkSection
      title={KIN_OUTLOOK.title}
      action={
        longer ? (
          <Button size="xs" variant="ghost" onClick={() => setAll(!all)}>
            {all ? "Show less" : KIN_QUOTES.seeAll}
          </Button>
        ) : undefined
      }
    >
      {state._tag === "loading" ? (
        <Loading label={`Loading ${KIN_OUTLOOK.title}`} />
      ) : view === null ? (
        <Failed text={KIN_OUTLOOK.loadFailed} onRetry={refresh} />
      ) : (
        <div className="flex flex-col gap-3">
          {view.empty ? (
            <p className="px-2 text-sm text-muted-foreground">{KIN_OUTLOOK.empty}</p>
          ) : (
            <div className="grid grid-cols-3 gap-x-4 px-2">
              {(
                [
                  [KIN_OUTLOOK.comingIn, view.comingIn],
                  [KIN_OUTLOOK.goingOut, view.goingOut],
                  [KIN_OUTLOOK.net, view.net],
                ] as const
              ).map(([label, lines]) => (
                <div key={label} className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  {lines.length === 0 ? (
                    <span className="text-base font-semibold text-foreground">
                      {KIN_OUTLOOK.nothing}
                    </span>
                  ) : (
                    lines.map((line) => (
                      <span key={line} className="flex flex-col">
                        <span className="text-base font-semibold text-foreground tabular-nums">
                          {line}
                        </span>
                        {view.estimates.get(line) === undefined ? null : (
                          <span className="text-xs text-muted-foreground">
                            {view.estimates.get(line)}
                          </span>
                        )}
                      </span>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
          <OutlookRows
            title={KIN_OUTLOOK.comingIn}
            rows={view.incoming}
            all={all}
            more={view.more.incoming}
            onOpenKey={props.onOpenKey}
          />
          <OutlookRows
            title={KIN_OUTLOOK.goingOut}
            rows={view.outgoing}
            all={all}
            more={view.more.outgoing}
            onOpenKey={props.onOpenKey}
          />
          <PartnersOwed {...props} rows={view.partners} unsaid={view.unsaid} />
          {view.notes.length + view.runway.length === 0 ? null : (
            <p className="px-2 text-xs text-muted-foreground">
              {[...view.notes, ...view.runway.map((one) => one.text)].join(" ")}
            </p>
          )}
        </div>
      )}
    </KinWorkSection>
  );
}

/** Open quotes first, each opening the quote; See all opens the whole list. */
export function KinQuotesSection(
  props: Section & {
    readonly lists: ReadonlyArray<KinListDefinition>;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenList: (open: KinListOpen) => void;
  },
) {
  const def = props.lists.find((one) => one.list === KIN_QUOTES_LIST) ?? null;
  if (def === null) return null;
  return <QuotesPeek {...props} />;
}

// As Money counts them: no suggestion is an open quote until it is kept.
const OPEN_QUOTES = { ...KIN_LIST_DEFAULT_FILTER, show: "notClosed" as const, kept: true };

function QuotesPeek(
  props: Section & {
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenList: (open: KinListOpen) => void;
  },
) {
  const now = new Date(useNowMinuteMs());
  const { state } = useKinListEntries(props, KIN_QUOTES_LIST, OPEN_QUOTES, props.seq);
  const rows = state.records.map((record) => kinQuoteRow(record, props.rates, now));
  return (
    <KinWorkSection
      title={KIN_QUOTES.title}
      fold={{
        summary: state.loading && rows.length === 0 ? null : kinQuotesSummary(rows, state.total),
      }}
      action={
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            props.onOpenList({ list: KIN_QUOTES_LIST, filter: KIN_LIST_DEFAULT_FILTER })
          }
        >
          {KIN_QUOTES.seeAll}
        </Button>
      }
    >
      {state.loading && rows.length === 0 ? (
        <Loading label={`Loading ${KIN_QUOTES.title}`} />
      ) : state.failed != null && rows.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{KIN_QUOTES.loadFailed}.</p>
      ) : rows.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{KIN_QUOTES.noneOpen}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.slice(0, PEEK).map((row) => (
            <li key={row.key}>
              <Row
                label={`${row.number} · ${row.party}`}
                note={[row.stateLabel, row.when].filter(Boolean).join(" · ")}
                late={row.state === "expired"}
                amount={row.amount}
                estimate={row.estimate}
                onOpen={() => props.onOpenKey(row.key)}
              />
            </li>
          ))}
        </ul>
      )}
      {rows.length > PEEK ? (
        <p className="px-2 text-xs text-muted-foreground">
          {KIN_OUTLOOK.more((state.total ?? rows.length) - PEEK)}
        </p>
      ) : null}
    </KinWorkSection>
  );
}

const STATUS_BADGE = { over: "error", near: "warning", ok: null } as const;

function BudgetRow(props: {
  readonly view: KinBudgetView;
  readonly canChange: boolean;
  readonly onEdit: () => void;
}) {
  const { view } = props;
  const badge = STATUS_BADGE[view.status];
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm text-foreground">{view.label}</span>
            {badge === null ? null : (
              <Badge size="sm" variant={badge}>
                {view.status === "over" ? KIN_BUDGETS.overBadge : KIN_BUDGETS.near}
              </Badge>
            )}
          </span>
          <span className="shrink-0 text-sm text-foreground tabular-nums">{view.spent}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              view.status === "over"
                ? "bg-destructive"
                : view.status === "near"
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{ width: `${Math.round(view.share * 100)}%` }}
          />
        </div>
        <span
          className={cn(
            "text-xs",
            view.status === "over" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {view.standing}
          {view.estimate === null ? null : ` · limit ${view.estimate}`}
        </span>
        {view.notCounted === null ? null : (
          <span className="text-xs text-muted-foreground">{view.notCounted}</span>
        )}
      </div>
      {props.canChange ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${KIN_BUDGETS.edit}: ${view.label}`}
          onClick={props.onEdit}
        >
          <PencilIcon />
        </Button>
      ) : null}
    </div>
  );
}

/** This month's budgets, over and near first; the owner sets, changes and removes them here. */
export function KinBudgetsSection(props: Section & { readonly lists: KinListsHandle }) {
  const { state, refresh } = useKinBudgets(props, true);
  const canChange = useAtomValue(kinClient.workSetBudget.permissionAtom(props.environmentId));
  const [editing, setEditing] = useState<KinMoneyBudget | "new" | null>(null);
  const [all, setAll] = useState(false);
  const expenses = kinListsOf(props.lists).find((one) => one.list === "expenses") ?? null;
  if (state._tag === "refused" || state._tag === "gone") return null;
  const views = state._tag === "ready" ? kinBudgetsView(state.value, expenses, props.rates) : [];
  // Absent with none set: Money's Add sets the first one.
  if (state._tag === "ready" && views.length === 0) return null;
  return (
    <KinWorkSection
      title={KIN_BUDGETS.title}
      fold={{ summary: views.length === 0 ? null : kinBudgetsSummary(views) }}
      action={
        <div className="flex items-center gap-1">
          {views.length > PEEK ? (
            <Button size="xs" variant="ghost" onClick={() => setAll(!all)}>
              {all ? "Show less" : KIN_QUOTES.seeAll}
            </Button>
          ) : null}
          {canChange && expenses !== null ? (
            <Button size="xs" variant="ghost" onClick={() => setEditing("new")}>
              <PlusIcon />
              {KIN_BUDGETS.add}
            </Button>
          ) : null}
        </div>
      }
    >
      {state._tag === "loading" ? (
        <Loading label={`Loading ${KIN_BUDGETS.title}`} />
      ) : state._tag === "failed" ? (
        <Failed text={KIN_BUDGETS.loadFailed} onRetry={refresh} />
      ) : views.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{KIN_BUDGETS.empty}</p>
      ) : (
        <ul className="flex flex-col">
          {(all ? views : views.slice(0, PEEK)).map((view) => (
            <li key={view.id}>
              <BudgetRow view={view} canChange={canChange} onEdit={() => setEditing(view.budget)} />
            </li>
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <KinBudgetDialog
          {...props}
          expenses={expenses}
          budget={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </KinWorkSection>
  );
}

const ANY = "__any__";

export function KinBudgetDialog(
  props: Section & {
    readonly expenses: KinListDefinition | null;
    readonly budget: KinMoneyBudget | null;
    readonly onClose: () => void;
  },
) {
  const { budget } = props;
  const [draft, setDraft] = useState<KinBudgetDraft>(() => kinBudgetDraftOf(budget));
  const [requestId] = useState(randomUUID);
  const [problem, setProblem] = useState<string | null>(null);
  const setter = useKinBudgetSet(props);
  const { projects } = useKinWorkChoices(props, true);
  const ids = { category: useId(), limit: useId() };
  const categories = props.expenses?.categories ?? [];
  const label = (category: string) => props.expenses?.categoryLabels?.[category] ?? category;
  const home = props.rates?.home ?? props.expenses?.currency ?? KIN_DEFAULT_HOME_CURRENCY;
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
    props.onClose();
  };
  const remove = async () => {
    const input = budget === null ? null : kinBudgetRemoval(props.orgId, budget, `${requestId}:rm`);
    if (input !== null && (await setter.set(input))) props.onClose();
  };
  const shownProblem = problem ?? setter.problem;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !setter.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{budget === null ? KIN_BUDGETS.add : KIN_BUDGETS.edit}</DialogTitle>
            <DialogDescription>{KIN_BUDGETS.detail}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.category}>{KIN_BUDGETS.category}</Label>
                <Select
                  value={draft.category ?? ANY}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      category: categories.find((one) => one === value) ?? null,
                    })
                  }
                >
                  <SelectTrigger id={ids.category} className="w-full">
                    <SelectValue>
                      {draft.category === null ? KIN_BUDGETS.anyCategory : label(draft.category)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={ANY}>{KIN_BUDGETS.anyCategory}</SelectItem>
                    {categories.map((one) => (
                      <SelectItem key={one} value={one}>
                        {label(one)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <KinPlaceCombobox
                target={props}
                noun="project"
                label={KIN_BUDGETS.project}
                placeholder={KIN_BUDGETS.anyProject}
                value={draft.project}
                choices={projects}
                onChange={(project) => setDraft({ ...draft, project })}
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.limit}>{KIN_BUDGETS.limit}</Label>
                <Input
                  id={ids.limit}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.limit}
                  onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
                />
              </div>
              {shownProblem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{shownProblem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {budget === null ? null : (
              <Button
                type="button"
                variant="destructive-outline"
                className="sm:me-auto"
                disabled={setter.busy}
                onClick={() => void remove()}
              >
                <Trash2Icon />
                {KIN_BUDGETS.remove}
              </Button>
            )}
            <Button type="button" variant="outline" disabled={setter.busy} onClick={props.onClose}>
              {KIN_WORK_COPY.cancel}
            </Button>
            <Button type="submit" disabled={setter.busy} aria-busy={setter.busy}>
              {KIN_BUDGETS.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** An invoice's or quote's lines, each with its SAC or HSN code, edited in the Make form. */
export function KinLinesEditor(props: {
  readonly lines: ReadonlyArray<KinLineDraft>;
  readonly disabled: boolean;
  readonly onChange: (lines: ReadonlyArray<KinLineDraft>) => void;
  /** Each line's SAC or HSN code, which only India's invoices carry; shown unless false. */
  readonly codes?: boolean;
  readonly detail?: string;
}) {
  const codes = props.codes !== false;
  const set = (index: number, patch: Partial<KinLineDraft>) =>
    props.onChange(props.lines.map((one, at) => (at === index ? { ...one, ...patch } : one)));
  const field = (
    index: number,
    key: keyof KinLineDraft,
    label: string,
    extra: {
      readonly className: string;
      readonly inputMode?: "numeric" | "decimal";
      readonly maxLength?: number;
    },
  ) => (
    <Input
      aria-label={`${label}, line ${index + 1}`}
      className={extra.className}
      placeholder={label}
      autoComplete="off"
      {...(extra.inputMode === undefined ? {} : { inputMode: extra.inputMode })}
      {...(extra.maxLength === undefined ? {} : { maxLength: extra.maxLength })}
      disabled={props.disabled}
      value={props.lines[index]![key]}
      onChange={(event) => set(index, { [key]: event.target.value })}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-foreground">{KIN_LINES.title}</span>
        <span className="text-xs text-muted-foreground">{props.detail ?? KIN_LINES.detail}</span>
      </div>
      {props.lines.map((_, index) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- lines have no id; a row is its place
          key={index}
          className={cn(
            "grid grid-cols-[1fr_1fr_auto] gap-2",
            codes
              ? "sm:grid-cols-[3fr_1.4fr_0.8fr_1fr_1.6fr_auto]"
              : "sm:grid-cols-[3fr_0.8fr_1fr_1.6fr_auto]",
          )}
        >
          {field(index, "description", KIN_LINES.description, {
            className: "col-span-3 sm:col-span-1",
            maxLength: 300,
          })}
          {codes
            ? field(index, "sac", KIN_LINES.sac, {
                className: "",
                inputMode: "numeric",
                maxLength: 8,
              })
            : null}
          {field(index, "quantity", KIN_LINES.quantity, {
            className: codes ? "" : "col-span-2 sm:col-span-1",
            inputMode: "decimal",
          })}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="sm:order-last"
            aria-label={`${KIN_LINES.remove} ${index + 1}`}
            disabled={props.disabled}
            onClick={() => props.onChange(props.lines.filter((__, at) => at !== index))}
          >
            <Trash2Icon />
          </Button>
          {field(index, "unit", KIN_LINES.unit, { className: "", maxLength: 20 })}
          {field(index, "rate", KIN_LINES.rate, {
            className: "col-span-2 sm:col-span-1",
            inputMode: "decimal",
          })}
        </div>
      ))}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.disabled}
          onClick={() => props.onChange([...props.lines, KIN_EMPTY_LINE])}
        >
          <PlusIcon />
          {KIN_LINES.add}
        </Button>
      </div>
    </div>
  );
}
