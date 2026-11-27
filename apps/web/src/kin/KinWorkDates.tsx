import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_CALENDAR,
  kinCalendarDeviceKey,
  kinCalendarNotice,
  kinCalendarSwitchShown,
  type KinCalendarNotice,
  type KinCalendarRowView,
} from "@t3tools/client-runtime/kin/kinCalendar";
import {
  KIN_DATES,
  KIN_WEEKDAYS,
  kinAgendaWindow,
  kinDatesAgenda,
  kinDatesMonth,
  kinMonthWindow,
  kinOwnerToday,
  kinShiftMonth,
  type KinDateRowView,
  type KinDatesEntry,
} from "@t3tools/client-runtime/kin/kinDates";
import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecordKey } from "@t3tools/contracts";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import {
  KinWorkNotice,
  KinWorkRowSkeletons,
  KinLoadFailed,
  KinWorkStaleLine,
} from "./KinWorkParts";
import { kinCalendarShownHere, rememberKinCalendarShown } from "./kinCalendarShown";
import { useNowMinuteMs } from "./useKinClock";
import { useKinCalendar, useKinDates } from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

/** One dated entry: what it is, which list it is in, and what it is waiting for. */
function KinDateRow(props: {
  readonly row: KinDateRowView;
  /** Outside an agenda, where no heading says the day. */
  readonly showDay?: boolean;
  readonly onOpen: (key: KinRecordKey) => void;
}) {
  const { row } = props;
  const lead = [props.showDay ? row.when : null, row.time, row.line].filter(
    (part) => part !== null,
  );
  return (
    <button
      type="button"
      aria-label={row.accessibilityLabel}
      onClick={() => props.onOpen(row.key)}
      className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "line-clamp-2 text-sm text-foreground",
            row.closed && "text-muted-foreground line-through",
          )}
        >
          {row.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">{lead.join(" · ")}</span>
      </span>
      {row.amount === null ? null : (
        <span className="shrink-0 text-sm text-foreground tabular-nums">{row.amount}</span>
      )}
      {row.late ? (
        <Badge size="sm" variant="error">
          {KIN_DATES.overdue}
        </Badge>
      ) : null}
    </button>
  );
}

const ROW = "flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start";
const OPENS =
  "outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** A calendar event: never late or closed, read only, and opened on the provider's own page. */
function KinCalendarRow(props: { readonly event: KinCalendarRowView; readonly dim: boolean }) {
  const { event } = props;
  const body = (
    <>
      <CalendarIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-sm text-foreground">{event.title}</span>
        <span className="truncate text-xs text-muted-foreground">{event.line}</span>
      </span>
      {event.link === null ? null : (
        <ExternalLinkIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )}
    </>
  );
  return event.link === null ? (
    <div aria-label={event.accessibilityLabel} className={cn(ROW, props.dim && "opacity-70")}>
      {body}
    </div>
  ) : (
    <a
      href={event.link}
      target="_blank"
      rel="noreferrer"
      aria-label={event.accessibilityLabel}
      className={cn(ROW, OPENS, props.dim && "opacity-70")}
    >
      {body}
    </a>
  );
}

/** The calendar's one line under the toolbar; Work's rows never wait on it. */
function KinCalendarLine(props: {
  readonly notice: KinCalendarNotice;
  readonly onRetry: () => void;
}) {
  return (
    <p
      role={props.notice.status ? "status" : undefined}
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>{props.notice.text}</span>
      {props.notice.retry ? (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          {KIN_RETRY}
        </Button>
      ) : null}
    </p>
  );
}

type Mode = "agenda" | "month";

/**
 * Everything with a date, whatever list it is in: by day, or a month at a time where there is
 * room for a grid.
 */
export function KinWorkDates(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const today = kinOwnerToday(now, names);
  const [mode, setMode] = useState<Mode>("agenda");
  const [openOnly, setOpenOnly] = useState(true);
  const [month, setMonth] = useState(() => today.slice(0, 7));
  // The owner's zone decides where a day starts; nothing is asked until it is known.
  const window =
    names.zone === null
      ? null
      : mode === "agenda"
        ? kinAgendaWindow(today, names.zone)
        : kinMonthWindow(month, names.zone);
  const { state, retry } = useKinDates(
    props,
    window,
    openOnly,
    props.stale ? null : props.live.seq,
  );
  // Remembered in this browser for this person in this company; nothing is asked while off.
  const deviceKey =
    names.me === null ? null : kinCalendarDeviceKey(props.environmentId, props.orgId, names.me);
  const [chosen, setChosen] = useState<{ readonly key: string; readonly on: boolean } | null>(null);
  const calendarOn =
    deviceKey === null
      ? null
      : chosen?.key === deviceKey
        ? chosen.on
        : kinCalendarShownHere(deviceKey);
  const calendar = useKinCalendar(props, state._tag === "refused" ? null : window, calendarOn);
  const events = calendar.state._tag === "ready" ? calendar.state.calendar : undefined;
  const eventsDim = calendar.state._tag === "ready" && calendar.state.refreshing;
  const calendarNotice = kinCalendarNotice(calendar.state);
  const switchId = useId();
  const calendarSwitchId = useId();
  if (state._tag === "refused") return <KinWorkNotice {...KIN_MONEY.onlyOwner} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6 scrollbar-gutter-both">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-4 px-4 pt-3",
          mode === "month" ? "max-w-5xl" : "max-w-3xl",
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          {/* A month grid needs room; a narrow window keeps the agenda. */}
          <div className="hidden md:block">
            <ToggleGroup
              aria-label={KIN_DATES.title}
              value={[mode]}
              onValueChange={(value) => {
                if (value[0] === "agenda" || value[0] === "month") setMode(value[0]);
              }}
            >
              <Toggle value="agenda">{KIN_DATES.agenda}</Toggle>
              <Toggle value="month">{KIN_DATES.month}</Toggle>
            </ToggleGroup>
          </div>
          <div className="ms-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {deviceKey !== null && kinCalendarSwitchShown(calendar.state) ? (
              <div className="flex items-center gap-2">
                <Label htmlFor={calendarSwitchId}>{KIN_CALENDAR.toggle}</Label>
                <Switch
                  id={calendarSwitchId}
                  size="sm"
                  checked={calendarOn === true}
                  onCheckedChange={(on) => {
                    rememberKinCalendarShown(deviceKey, on);
                    setChosen({ key: deviceKey, on });
                  }}
                />
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <Label htmlFor={switchId}>{KIN_DATES.openOnly}</Label>
              <Switch id={switchId} size="sm" checked={openOnly} onCheckedChange={setOpenOnly} />
            </div>
          </div>
        </div>
        {props.stale ? <KinWorkStaleLine environmentId={props.environmentId} /> : null}
        {calendarNotice === null ? null : (
          <KinCalendarLine notice={calendarNotice} onRetry={calendar.retry} />
        )}
        {mode === "month" ? (
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={KIN_DATES.previous}
              onClick={() => setMonth(kinShiftMonth(month, -1))}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={KIN_DATES.next}
              onClick={() => setMonth(kinShiftMonth(month, 1))}
            >
              <ChevronRightIcon />
            </Button>
            <h2 className="text-sm font-medium text-foreground" aria-live="polite">
              {kinDatesMonth(month, [], names, now).label}
            </h2>
            {month === today.slice(0, 7) ? null : (
              <Button size="xs" variant="ghost" onClick={() => setMonth(today.slice(0, 7))}>
                {KIN_DATES.today}
              </Button>
            )}
          </div>
        ) : null}
        {state._tag === "failed" ? (
          <KinLoadFailed what={KIN_DATES.loadFailed} cause={null} onRetry={retry} />
        ) : state._tag === "loading" || window === null ? (
          <div role="status" aria-label="Loading dates">
            <KinWorkRowSkeletons />
          </div>
        ) : (
          <div className={cn("flex flex-col gap-4", state.refreshing && "opacity-70")}>
            {state.more ? (
              <p role="status" className="text-xs text-muted-foreground">
                {KIN_DATES.more}
              </p>
            ) : null}
            {mode === "month" ? (
              <MonthGrid
                weeks={kinDatesMonth(month, state.rows, names, now, events).weeks}
                eventsDim={eventsDim}
                onOpenKey={props.onOpenKey}
              />
            ) : (
              <KinAgenda
                days={kinDatesAgenda(state.rows, names, now, events)}
                today={today}
                eventsDim={eventsDim}
                onOpenKey={props.onOpenKey}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KinAgenda(props: {
  readonly days: ReturnType<typeof kinDatesAgenda>;
  readonly today: string;
  readonly eventsDim: boolean;
  readonly onOpenKey: (key: KinRecordKey) => void;
}) {
  const { today } = props;
  return props.days.length === 0 ? (
    <KinWorkNotice {...KIN_DATES.none} />
  ) : (
    props.days.map((day) => (
      <section key={day.day} className="flex flex-col gap-1">
        <h3
          className={cn(
            "px-2 text-xs font-medium",
            day.day === today ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {day.label}
        </h3>
        <ul className="flex flex-col">
          {day.entries.map((entry) => (
            <li key={entry.id}>
              {entry.kind === "work" ? (
                <KinDateRow row={entry.row} onOpen={props.onOpenKey} />
              ) : (
                <KinCalendarRow event={entry.event} dim={props.eventsDim} />
              )}
            </li>
          ))}
        </ul>
      </section>
    ))
  );
}

const CELL_ROWS = 3;

const CHIP =
  "truncate rounded-sm px-1 py-0.5 text-start text-xs outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** One entry in a month cell: a Work row opens here, an event on its provider's page. */
function MonthChip(props: {
  readonly entry: KinDatesEntry;
  readonly eventsDim: boolean;
  readonly onOpenKey: (key: KinRecordKey) => void;
}) {
  const { entry } = props;
  if (entry.kind === "work") {
    const { row } = entry;
    return (
      <button
        type="button"
        aria-label={row.accessibilityLabel}
        onClick={() => props.onOpenKey(row.key)}
        className={cn(
          CHIP,
          row.late
            ? "text-destructive-foreground"
            : row.closed
              ? "text-muted-foreground line-through"
              : "text-foreground",
        )}
      >
        {row.title}
      </button>
    );
  }
  const { event } = entry;
  const body = (
    <>
      <CalendarIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{event.title}</span>
    </>
  );
  const look = cn(
    "flex min-w-0 items-center gap-1 text-foreground",
    props.eventsDim && "opacity-70",
  );
  return event.link === null ? (
    <span aria-label={event.accessibilityLabel} className={cn(CHIP, look)}>
      {body}
    </span>
  ) : (
    <a
      href={event.link}
      target="_blank"
      rel="noreferrer"
      aria-label={event.accessibilityLabel}
      className={cn(CHIP, look)}
    >
      {body}
    </a>
  );
}

function MonthGrid(props: {
  readonly weeks: ReturnType<typeof kinDatesMonth>["weeks"];
  readonly eventsDim: boolean;
  readonly onOpenKey: (key: KinRecordKey) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-7 border-b border-border bg-muted/40">
        {KIN_WEEKDAYS.map((weekday) => (
          <div key={weekday} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {weekday}
          </div>
        ))}
      </div>
      {props.weeks.map((week) => (
        <div key={week[0]?.day} className="grid grid-cols-7 border-b border-border last:border-b-0">
          {week.map((cell) => (
            <div
              key={cell.day}
              className={cn(
                "flex min-h-24 min-w-0 flex-col gap-0.5 border-e border-border p-1 last:border-e-0",
                !cell.inMonth && "bg-muted/30",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center self-start rounded-full text-xs tabular-nums",
                  cell.today
                    ? "bg-primary font-medium text-primary-foreground"
                    : cell.inMonth
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {cell.number}
              </span>
              {cell.entries.slice(0, CELL_ROWS).map((entry) => (
                <MonthChip
                  key={entry.id}
                  entry={entry}
                  eventsDim={props.eventsDim}
                  onOpenKey={props.onOpenKey}
                />
              ))}
              {cell.entries.length > CELL_ROWS ? (
                <span className="px-1 text-xs text-muted-foreground">
                  {cell.entries.length - CELL_ROWS} more
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
