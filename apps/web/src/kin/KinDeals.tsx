import {
  KIN_DEALS,
  KIN_DEALS_STATES,
  kinDealConcernRows,
  kinDealDrop,
  kinDealMoves,
  kinDealRow,
  kinDealsByStage,
  kinDealsHeader,
  kinDealsNothing,
  kinDealsNotRead,
  kinDealsQuery,
  kinDealsRaised,
  kinDealsRaisedInput,
  kinDealsSection,
  kinDealStageBeside,
  type KinDealNextView,
  type KinDealRowView,
  type KinDealsFilter,
} from "@t3tools/client-runtime/kin/kinDeals";
import { kinParseMoney } from "@t3tools/client-runtime/kin/kinLists";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import type {
  KinDealMove,
  KinDealRow,
  KinDealStage,
  KinDealsInput,
  KinDealsResult,
  KinPersonId,
  KinRecordKey,
} from "@t3tools/contracts";
import { ChevronDownIcon, MoreHorizontalIcon, PlusIcon, TrophyIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
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
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn, randomUUID } from "../lib/utils";
import { KinPlaceCombobox } from "./KinPlaceCombobox";
import { Field, FormShell } from "./KinWorkForms";
import {
  KinLoadFailed,
  KinWorkNotice,
  KinWorkPrivateMark,
  KinWorkRowSkeletons,
  KinWorkSection,
} from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinDeals, useKinDealSend, useKinDealStages } from "./useKinDeals";
import { useKinHomeCurrency, useKinRates } from "./useKinMoney";
import { useKinDealsStart, useKinOwnerLevel } from "./useKinOwnerLevel";
import type { KinWorkChoices, KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const TONE: Record<KinDealNextView["tone"], string> = {
  plain: "text-muted-foreground",
  missing: "text-warning-foreground",
  late: "text-destructive-foreground",
};

/** A deal's next step, or that it has none (amber), or that it is late (red). */
export function KinDealNextLine(props: { readonly next: KinDealNextView | null }) {
  if (props.next === null) return null;
  return (
    <span className={cn("truncate text-xs", TONE[props.next.tone])} data-tone={props.next.tone}>
      {props.next.text}
    </span>
  );
}

function DealRowButton(props: {
  readonly row: KinDealRowView;
  readonly selected: boolean;
  readonly pill?: string;
  readonly onOpen: () => void;
}) {
  const { row } = props;
  return (
    <button
      type="button"
      data-kin-row={row.key}
      aria-label={row.accessibilityLabel}
      aria-current={props.selected ? true : undefined}
      onClick={props.onOpen}
      className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm text-foreground">{row.title}</span>
          {row.private ? <KinWorkPrivateMark /> : null}
        </span>
        {row.line === "" ? null : (
          <span className="truncate text-xs text-muted-foreground">{row.line}</span>
        )}
        <KinDealNextLine next={row.next} />
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {row.value === null ? null : (
          <span className="text-sm tabular-nums text-foreground">{row.value}</span>
        )}
        {props.pill === undefined ? null : <Badge variant="outline">{props.pill}</Badge>}
      </span>
    </button>
  );
}

/** Who and which: the web's two filters. A teammate starts on their own. */
function DealsFilters(props: {
  readonly filter: KinDealsFilter;
  readonly directory: KinWorkDirectory;
  readonly onFilter: (filter: KinDealsFilter) => void;
}) {
  const { filter, directory } = props;
  const people = [...directory.names.people.entries()].filter(([id]) => id !== directory.names.me);
  const whoLabel =
    filter.who._tag === "everyone"
      ? KIN_DEALS.everyone
      : filter.who._tag === "me"
        ? KIN_DEALS.me
        : (directory.names.people.get(filter.who.personId) ?? KIN_DEALS.someone);
  const whoValue = filter.who._tag === "person" ? `person:${filter.who.personId}` : filter.who._tag;
  return (
    <div className="flex items-center gap-1">
      <Menu>
        <MenuTrigger
          render={
            <Button size="xs" variant="outline" aria-label={`${KIN_DEALS.whose}: ${whoLabel}`} />
          }
        >
          {whoLabel}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={whoValue}
            onValueChange={(value: string) =>
              props.onFilter({
                ...filter,
                who:
                  value === "everyone"
                    ? { _tag: "everyone" }
                    : value === "me"
                      ? { _tag: "me" }
                      : { _tag: "person", personId: value.slice(7) as KinPersonId },
              })
            }
          >
            <MenuRadioItem value="everyone">{KIN_DEALS.everyone}</MenuRadioItem>
            <MenuRadioItem value="me">{KIN_DEALS.me}</MenuRadioItem>
            {people.length === 0 ? null : (
              <MenuGroup>
                <MenuGroupLabel>{KIN_DEALS.someone}</MenuGroupLabel>
                {people.map(([id, name]) => (
                  <MenuRadioItem key={id} value={`person:${id}`}>
                    {name}
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label={`${KIN_DEALS.which}: ${KIN_DEALS_STATES.find((s) => s.id === filter.state)?.label}`}
            />
          }
        >
          {KIN_DEALS_STATES.find((state) => state.id === filter.state)?.label}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={filter.state}
            onValueChange={(value: string) => {
              const state = KIN_DEALS_STATES.find((held) => held.id === value);
              if (state !== undefined) props.onFilter({ ...filter, state: state.id });
            }}
          >
            {KIN_DEALS_STATES.map((state) => (
              <MenuRadioItem key={state.id} value={state.id}>
                {state.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** Asks why a deal was lost, in a line, before it is marked lost. */
export function KinDealLostDialog(props: {
  readonly title: string;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onLost: (reason: string) => void;
  readonly onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() !== "") props.onLost(reason.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{KIN_DEALS.lostAsk}</DialogTitle>
            <DialogDescription>{props.title}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{KIN_DEALS.lostAsk}</Label>
              <Input
                id={id}
                autoFocus
                maxLength={280}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{KIN_DEALS.lostHint}</p>
              {props.problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{props.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={reason.trim() === "" || props.busy}
              aria-busy={props.busy}
            >
              {KIN_DEALS.lostConfirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** "Move to…": the stages, Won, and Lost (which asks why); Reopen for a closed deal. */
export function KinDealMoveMenu(props: {
  readonly deal: KinDealRow;
  readonly stages: ReadonlyArray<KinDealStage>;
  readonly disabled: boolean;
  readonly size?: "xs" | "icon-xs";
  readonly onMove: (to: KinDealMove) => void;
  readonly onLost: () => void;
}) {
  const choices = kinDealMoves(props.deal, props.stages);
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <Button
            size={props.size ?? "xs"}
            variant={props.size === "icon-xs" ? "ghost-muted" : "outline"}
            aria-label={`${KIN_DEALS.moveTo} ${props.deal.title}`}
          />
        }
      >
        {props.size === "icon-xs" ? (
          <MoreHorizontalIcon />
        ) : (
          <>
            {KIN_DEALS.stage}
            <ChevronDownIcon />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="end">
        {choices.map((choice, index) => (
          <span key={choice.id} className="contents">
            {choice.id === "won" && index > 0 ? <MenuSeparator /> : null}
            <MenuItem
              disabled={choice.current}
              onClick={() => (choice.to === null ? props.onLost() : props.onMove(choice.to))}
            >
              {choice.id === "won" ? <TrophyIcon aria-hidden /> : null}
              {choice.id === "lost" ? <XIcon aria-hidden /> : null}
              {choice.label}
              {choice.current ? (
                <span className="ms-auto text-xs text-muted-foreground">✓</span>
              ) : null}
            </MenuItem>
          </span>
        ))}
      </MenuPopup>
    </Menu>
  );
}

type Pending = { readonly key: KinRecordKey } | null;

/** The Deals tab: the board on a wide window, the list by stage on a narrow one. */
export function KinDealsTab(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly selected: KinRecordKey | null;
    readonly onOpen: (key: KinRecordKey) => void;
    readonly onNew: (() => void) | null;
  },
) {
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  const start = useKinDealsStart(props.environmentId);
  const [chosen, setFilter] = useState<KinDealsFilter | null>(null);
  const query = kinDealsQuery(props.orgId, chosen, start, props.directory.names.me);
  const filter = query?.filter ?? null;
  const { state, refresh } = useKinDeals(props, query?.input ?? null);
  const rates = useKinRates(props, ownerLevel);
  const wide = useMediaQuery("md");
  const now = new Date(useNowMinuteMs());
  const send = useKinDealSend(props);
  const [pending, setPending] = useState<Pending>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [losing, setLosing] = useState<KinDealRow | null>(null);
  const [said, setSaid] = useState("");
  const [concern, setConcern] = useState<string | null>(null);

  const move = async (deal: KinDealRow, to: KinDealMove) => {
    setPending({ key: deal.key });
    setProblem(null);
    const outcome = await send.move(deal, to);
    setPending(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    setSaid(
      `${deal.title}: ${outcome.value.deal.state === "open" ? kinStage(outcome.value.deal, state._tag === "ready" ? state.value.stages : []) : outcome.value.deal.state}`,
    );
    refresh();
    if (to._tag === "lost") setLosing(null);
  };

  if (state._tag === "loading" || filter === null)
    return (
      <div
        className="mx-auto w-full max-w-3xl p-4"
        role="status"
        aria-label={`Loading ${KIN_DEALS.title}`}
      >
        <KinWorkRowSkeletons />
      </div>
    );
  if (state._tag !== "ready") {
    const notRead = kinDealsNotRead(state);
    return notRead !== null || state._tag !== "failed" ? (
      <KinWorkNotice {...(notRead ?? KIN_DEALS.refused)} />
    ) : (
      <KinLoadFailed
        what={KIN_DEALS.loadFailed}
        cause={state.cause}
        onRetry={refresh}
        className="mx-auto w-full max-w-3xl p-4"
      />
    );
  }
  const result = state.value;
  const header = kinDealsHeader(result.open, rates);
  const columns = kinDealsByStage(result.stages, result.deals, props.directory.names, now);
  const empty = result.deals.length === 0;
  const nothing = kinDealsNothing(filter);
  const busy = pending !== null;
  const board = wide && filter.state === "open" && !empty;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex flex-col" aria-label={`${KIN_DEALS.open}: ${header.count}`}>
          <span className="text-xs text-muted-foreground">{KIN_DEALS.open}</span>
          {header.values.length === 0 ? (
            <span className="text-lg font-medium tabular-nums">{header.count}</span>
          ) : (
            <>
              {header.values.map((line) => (
                <span key={line} className="text-lg font-medium tabular-nums">
                  {line}
                </span>
              ))}
              <span className="text-xs text-muted-foreground">{header.count}</span>
            </>
          )}
          {header.estimate === null ? null : (
            <span className="text-xs text-muted-foreground">
              {KIN_DEALS.estimate(header.estimate)}
            </span>
          )}
        </div>
        <div className="ms-auto flex flex-wrap items-center justify-end gap-1">
          <DealsFilters filter={filter} directory={props.directory} onFilter={setFilter} />
          {/* At phone width the page header has no room for it, so it wraps here instead. */}
          {props.onNew === null ? null : (
            <span className="sm:hidden">
              <Button size="sm" onClick={props.onNew}>
                <PlusIcon />
                {KIN_DEALS.newDeal}
              </Button>
            </span>
          )}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      {problem === null ? null : (
        <Alert variant="error" className="mx-4 mt-3 w-auto">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {empty ? (
        <KinWorkNotice
          {...nothing}
          action={
            props.onNew === null || filter.state !== "open" ? undefined : (
              <Button size="sm" onClick={props.onNew}>
                <PlusIcon />
                {KIN_DEALS.newDeal}
              </Button>
            )
          }
        />
      ) : board ? (
        <DealsBoard
          stages={result.stages}
          columns={columns}
          busy={busy}
          pending={pending}
          selected={props.selected}
          onOpen={props.onOpen}
          onMove={move}
          onLost={setLosing}
        />
      ) : filter.state === "open" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {columns.map((column) =>
            column.count === 0 ? null : (
              <section key={column.id} aria-label={column.name} className="mb-3">
                <h2 className="flex items-baseline gap-2 px-2 py-1 text-xs font-medium text-muted-foreground">
                  <span className="text-foreground">{column.name}</span>
                  <span>{column.count}</span>
                  <span className="ms-auto tabular-nums">{column.total}</span>
                </h2>
                <ul className="flex flex-col">
                  {column.rows.map((row) => (
                    <li key={row.key}>
                      <DealRowButton
                        row={row}
                        selected={props.selected === row.key}
                        onOpen={() => props.onOpen(row.key)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {result.deals.map((deal) => {
            const row = kinDealRow(deal, props.directory.names, now);
            return (
              <li key={deal.key}>
                <DealRowButton
                  row={row}
                  selected={props.selected === deal.key}
                  onOpen={() => props.onOpen(deal.key)}
                />
                {deal.lostReason === undefined ? null : (
                  <p className="px-2 pb-1 text-xs text-muted-foreground">
                    {KIN_DEALS.lostWhy(deal.lostReason)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {result.more === 0 ? null : (
        <p className="px-4 py-2 text-xs text-muted-foreground">{KIN_DEALS.more(result.more)}</p>
      )}
      <WhatWeHear concerns={result.concerns} onOpen={setConcern} />
      {concern === null || query === null ? null : (
        <ConcernDealsDialog
          {...props}
          label={concern}
          input={kinDealsRaisedInput(query.input, concern)}
          onOpen={(key) => {
            setConcern(null);
            props.onOpen(key);
          }}
          onClose={() => setConcern(null)}
        />
      )}
      {board ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">{KIN_DEALS.boardHint}</p>
      ) : null}
      {losing === null ? null : (
        <KinDealLostDialog
          title={losing.title}
          busy={busy}
          problem={problem}
          onLost={(reason) => void move(losing, { _tag: "lost", reason })}
          onClose={() => {
            setLosing(null);
            setProblem(null);
          }}
        />
      )}
    </div>
  );
}

/** The concerns raised on the deals shown, counted by Kin; nothing at all until one is raised. */
function WhatWeHear(props: {
  readonly concerns: KinDealsResult["concerns"];
  readonly onOpen: (label: string) => void;
}) {
  const rows = kinDealConcernRows(props.concerns);
  if (rows.length === 0) return null;
  return (
    <section
      aria-label={KIN_DEALS.whatWeHear}
      className="max-h-64 shrink-0 overflow-y-auto border-t border-border px-4 py-3"
    >
      <h2 className="text-xs font-medium text-muted-foreground">{KIN_DEALS.whatWeHear}</h2>
      <ul className="mt-1 flex flex-col">
        {rows.map((row) => (
          <li key={row.label}>
            <button
              type="button"
              aria-label={`${KIN_DEALS.openConcern(row.label)}: ${row.deals}, ${row.stands}`}
              onClick={() => props.onOpen(row.label)}
              className="-mx-2 flex w-[calc(100%+--spacing(4))] flex-wrap items-baseline gap-x-3 rounded-md px-2 py-1 text-start text-sm outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
            >
              <span className="min-w-0 flex-1 text-foreground">{row.label}</span>
              <span className="tabular-nums">{row.deals}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{row.stands}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{KIN_DEALS.whatWeHearHint}</p>
    </section>
  );
}

/** The deals one concern was raised on, as the reader sees them; one opens its page. */
function ConcernDealsDialog(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly label: string;
    readonly input: KinDealsInput;
    readonly onOpen: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { state, refresh } = useKinDeals(props, props.input);
  const now = new Date(useNowMinuteMs());
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{props.label}</DialogTitle>
          <DialogDescription>{KIN_DEALS.raisedBy}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state._tag === "ready" ? (
            <ul className="-mx-2 flex flex-col">
              {kinDealsRaised(
                state.value.stages,
                state.value.deals,
                props.directory.names,
                now,
              ).map((row) => (
                <li key={row.key}>
                  <DealRowButton
                    row={row}
                    pill={row.pill}
                    selected={false}
                    onOpen={() => props.onOpen(row.key)}
                  />
                </li>
              ))}
              {state.value.more === 0 ? null : (
                <li className="px-2 py-1 text-xs text-muted-foreground">
                  {KIN_DEALS.more(state.value.more)}
                </li>
              )}
            </ul>
          ) : state._tag === "loading" ? (
            <div role="status" aria-label={`Loading ${KIN_DEALS.openConcern(props.label)}`}>
              <KinWorkRowSkeletons />
            </div>
          ) : kinDealsNotRead(state) !== null || state._tag !== "failed" ? (
            <KinWorkNotice {...(kinDealsNotRead(state) ?? KIN_DEALS.refused)} />
          ) : (
            <KinLoadFailed what={KIN_DEALS.loadFailed} cause={state.cause} onRetry={refresh} />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            {KIN_DEALS.close}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const kinStage = (deal: KinDealRow, stages: ReadonlyArray<KinDealStage>) =>
  stages.find((stage) => stage.id === deal.stage)?.name ?? "";

const DRAG_TYPE = "application/x-kin-deal";

/**
 * Columns of the company's stages, then Won and Lost. A card moves by drag, by its "Move to…"
 * menu, or by Shift+Arrow while focused; only the column under a drag is marked.
 */
function DealsBoard(props: {
  readonly stages: ReadonlyArray<KinDealStage>;
  readonly columns: ReturnType<typeof kinDealsByStage>;
  readonly busy: boolean;
  readonly pending: Pending;
  readonly selected: KinRecordKey | null;
  readonly onOpen: (key: KinRecordKey) => void;
  readonly onMove: (deal: KinDealRow, to: KinDealMove) => void;
  readonly onLost: (deal: KinDealRow) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<KinDealRow | null>(null);
  const drop = (target: string) => {
    const deal = dragging;
    setOver(null);
    setDragging(null);
    if (deal === null || props.busy) return;
    const to = kinDealDrop(deal, target);
    if (to === "lost") props.onLost(deal);
    else if (to !== null) props.onMove(deal, to);
  };
  const zone = (id: string) => ({
    onDragOver: (event: React.DragEvent) => {
      if (dragging === null) return;
      event.preventDefault();
      if (over !== id) setOver(id);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      drop(id);
    },
    "data-over": over === id ? true : undefined,
  });
  return (
    <div
      className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3"
      role="list"
      aria-label={KIN_DEALS.title}
    >
      {props.columns.map((column) => (
        <section
          key={column.id}
          role="listitem"
          aria-label={`${column.name}, ${column.count}`}
          className="flex min-h-0 w-64 shrink-0 flex-col rounded-lg bg-muted/50 data-over:bg-accent"
          {...zone(column.id)}
        >
          <h2 className="flex items-baseline gap-2 px-3 py-2 text-xs font-medium">
            <span className="text-foreground">{column.name}</span>
            <span className="ms-auto text-muted-foreground tabular-nums">
              {column.count}
              {column.total === "" ? "" : ` · ${column.total}`}
            </span>
          </h2>
          <ul className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {column.deals.map((deal, index) => {
              const row = column.rows[index];
              if (row === undefined) return null;
              return (
                <li key={deal.key}>
                  <DealCard
                    deal={deal}
                    row={row}
                    stages={props.stages}
                    busy={props.busy}
                    pending={props.pending?.key === deal.key}
                    selected={props.selected === deal.key}
                    onOpen={() => props.onOpen(deal.key)}
                    onMove={(to) => props.onMove(deal, to)}
                    onLost={() => props.onLost(deal)}
                    onDrag={(start) => {
                      setDragging(start ? deal : null);
                      if (!start) setOver(null);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div className="flex w-40 shrink-0 flex-col gap-3">
        <div
          className="flex h-24 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-sm text-success-foreground data-over:bg-success/8"
          {...zone("won")}
        >
          <TrophyIcon aria-hidden className="size-4" />
          {KIN_DEALS.dropWon}
        </div>
        <div
          className="flex h-24 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-sm text-destructive-foreground data-over:bg-destructive/8"
          {...zone("lost")}
        >
          <XIcon aria-hidden className="size-4" />
          {KIN_DEALS.dropLost}
        </div>
      </div>
    </div>
  );
}

function DealCard(props: {
  readonly deal: KinDealRow;
  readonly row: KinDealRowView;
  readonly stages: ReadonlyArray<KinDealStage>;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly selected: boolean;
  readonly onOpen: () => void;
  readonly onMove: (to: KinDealMove) => void;
  readonly onLost: () => void;
  readonly onDrag: (start: boolean) => void;
}) {
  const { deal, row } = props;
  const movable = deal.can.move && !props.busy;
  return (
    <div
      className="group relative rounded-md border border-border bg-card shadow-xs/5 aria-busy:opacity-60 data-selected:ring-2 data-selected:ring-inset data-selected:ring-ring"
      aria-busy={props.pending || undefined}
      data-selected={props.selected || undefined}
      draggable={movable}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, deal.key);
        event.dataTransfer.effectAllowed = "move";
        props.onDrag(true);
      }}
      onDragEnd={() => props.onDrag(false)}
    >
      <button
        type="button"
        data-kin-row={deal.key}
        aria-label={row.accessibilityLabel}
        aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight"
        onClick={props.onOpen}
        onKeyDown={(event) => {
          if (!event.shiftKey || !movable) return;
          const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
          if (step === null) return;
          event.preventDefault();
          const to = kinDealStageBeside(deal, props.stages, step);
          if (to !== null) props.onMove({ _tag: "stage", stage: to.id });
        }}
        className="flex w-full flex-col gap-0.5 rounded-md p-2.5 pe-8 text-start outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{deal.title}</span>
          {row.private ? <KinWorkPrivateMark /> : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">{deal.party.title}</span>
        <KinDealNextLine next={row.next} />
        <span className="mt-1 flex items-center gap-2 text-xs">
          <span className="truncate text-muted-foreground">{row.owner}</span>
          {row.value === null ? null : (
            <span className="ms-auto tabular-nums text-foreground">{row.value}</span>
          )}
        </span>
      </button>
      {!deal.can.move ? null : (
        <div className="absolute end-1 top-1">
          <KinDealMoveMenu
            deal={deal}
            stages={props.stages}
            disabled={props.busy}
            size="icon-xs"
            onMove={props.onMove}
            onLost={props.onLost}
          />
        </div>
      )}
    </div>
  );
}

/** A client's page: its deals, open first, with New deal. */
export function KinClientDeals(
  props: KinWorkTarget & {
    readonly party: KinWorkRef;
    readonly closed: boolean;
    readonly directory: KinWorkDirectory;
    readonly onOpen: (key: KinRecordKey) => void;
    readonly onNew: (() => void) | null;
  },
) {
  const { state } = useKinDeals(props, { orgId: props.orgId, party: props.party.key });
  const now = new Date(useNowMinuteMs());
  if (state._tag !== "ready") return null;
  const section = kinDealsSection(state.value.deals, props.directory.names, now, props.party.key);
  return (
    <KinWorkSection
      title={KIN_DEALS.section}
      action={
        state.value.canCreate && !props.closed && props.onNew !== null ? (
          <Button size="xs" variant="ghost" onClick={props.onNew}>
            <PlusIcon />
            {KIN_DEALS.newDeal}
          </Button>
        ) : undefined
      }
    >
      {section.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_DEALS.sectionNone}</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {section.rows.map((row) => (
            <li key={row.key}>
              <DealRowButton
                row={row}
                pill={row.pill}
                selected={false}
                onOpen={() => props.onOpen(row.key)}
              />
            </li>
          ))}
          {section.more === 0 ? null : (
            <li className="px-2 py-1 text-xs text-muted-foreground">{section.more} more</li>
          )}
        </ul>
      )}
    </KinWorkSection>
  );
}

const ME = "me";

/**
 * New deal: what, for whom, how much, when, which stage, who looks after it, and its first next
 * step, or an explicit "None yet".
 */
export function KinDealNewDialog(
  props: KinWorkTarget & {
    /** Fixed from a client's page; picked from the Deals tab. */
    readonly party: KinWorkRef | null;
    readonly choices: KinWorkChoices;
    readonly directory: KinWorkDirectory;
    readonly onAdded: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  const home = useKinHomeCurrency(props) ?? "USD";
  const send = useKinDealSend(props);
  const [requestId] = useState(randomUUID);
  const [party, setParty] = useState<KinWorkRef | null>(props.party);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [expected, setExpected] = useState("");
  const stagesRead = useKinDealStages(props).state;
  const stages = stagesRead._tag === "ready" ? stagesRead.value.stages : [];
  const [picked, setPicked] = useState<string | null>(null);
  const stage = picked ?? stages[0]?.id ?? "";
  const [owner, setOwner] = useState<string>(ME);
  const [source, setSource] = useState("");
  const [step, setStep] = useState("");
  const [stepDay, setStepDay] = useState("");
  const [noneYet, setNoneYet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = {
    title: useId(),
    value: useId(),
    expected: useId(),
    stage: useId(),
    owner: useId(),
    source: useId(),
    step: useId(),
    stepDay: useId(),
    none: useId(),
  };
  const money = value.trim() === "" ? null : kinParseMoney(value, home);
  const moneyBad = value.trim() !== "" && money === null;
  const canSave =
    party !== null && title.trim() !== "" && !moneyBad && (noneYet || step.trim() !== "");
  const people = [...props.directory.names.people.entries()].filter(
    ([id]) => id !== props.directory.names.me,
  );
  const save = async () => {
    if (!canSave || party === null) return;
    setBusy(true);
    setProblem(null);
    const outcome = await send.create({
      party: party.key,
      title: title.trim(),
      ...(stage === "" ? {} : { stage }),
      ...(money === null ? {} : { value: money }),
      ...(expected === "" ? {} : { expectedOn: expected }),
      ...(source.trim() === "" ? {} : { source: source.trim() }),
      ...(owner === ME ? {} : { owner: { _tag: "person", personId: owner as KinPersonId } }),
      ...(noneYet || step.trim() === ""
        ? {}
        : {
            next: {
              title: step.trim(),
              ...(stepDay === "" ? {} : { dueAt: stepDay, dueAllDay: true }),
            },
          }),
      clientRequestId: requestId,
    });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    props.onAdded(outcome.value.deal.key);
  };
  return (
    <FormShell
      title={KIN_DEALS.newDeal}
      submit={KIN_DEALS.add}
      saving={busy}
      canSave={canSave}
      problem={problem === null ? null : { kind: "invalid", text: problem }}
      onOpenExisting={() => {}}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      {props.party !== null ? (
        <p className="text-sm text-muted-foreground">For {props.party.title}</p>
      ) : (
        <KinPlaceCombobox
          target={props}
          noun="client"
          label={KIN_DEALS.clientField}
          value={party}
          choices={props.choices.clients}
          onChange={setParty}
        />
      )}
      <Field id={ids.title} label={KIN_DEALS.what}>
        <Input
          id={ids.title}
          autoFocus
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
      <div className="grid grid-cols-2 gap-3">
        <Field id={ids.stage} label={KIN_DEALS.stage}>
          <Select value={stage} onValueChange={(next) => setPicked(String(next))}>
            <SelectTrigger id={ids.stage} className="w-full min-w-0">
              <SelectValue>{stages.find((held) => held.id === stage)?.name}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {stages.map((held) => (
                <SelectItem key={held.id} value={held.id}>
                  {held.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        {!ownerLevel || people.length === 0 ? null : (
          <Field id={ids.owner} label={KIN_DEALS.lookedAfterBy}>
            <Select value={owner} onValueChange={(next) => setOwner(String(next))}>
              <SelectTrigger id={ids.owner} className="w-full min-w-0">
                <SelectValue>
                  {owner === ME ? "You" : props.directory.names.people.get(owner)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value={ME}>You</SelectItem>
                {people.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        )}
      </div>
      <Field id={ids.source} label={KIN_DEALS.cameFrom}>
        <Input
          id={ids.source}
          maxLength={120}
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field id={ids.step} label={KIN_DEALS.nextStep}>
          <Input
            id={ids.step}
            disabled={noneYet}
            maxLength={280}
            value={step}
            onChange={(event) => setStep(event.target.value)}
          />
        </Field>
        <Input
          id={ids.stepDay}
          type="date"
          aria-label="Next step's day"
          disabled={noneYet}
          value={stepDay}
          onChange={(event) => setStepDay(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={ids.none}
          checked={noneYet}
          onCheckedChange={(checked) => setNoneYet(checked === true)}
        />
        <Label htmlFor={ids.none}>{KIN_DEALS.noneYet}</Label>
      </div>
    </FormShell>
  );
}
