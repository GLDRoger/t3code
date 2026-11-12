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
} from "@t3tools/client-runtime/kin/kinDates";
import { KIN_WORK_STALE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecordKey } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { KinWorkNotice, KinWorkRowSkeletons } from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinDates } from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

/** One dated entry: what it is, which list it is in, and what it is waiting for. */
export function KinDateRow(props: {
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
  const switchId = useId();
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
          <div className="ms-auto flex items-center gap-2">
            <Label htmlFor={switchId}>{KIN_DATES.openOnly}</Label>
            <Switch id={switchId} size="sm" checked={openOnly} onCheckedChange={setOpenOnly} />
          </div>
        </div>
        {props.stale ? (
          <p role="status" className="text-xs text-muted-foreground">
            {KIN_WORK_STALE}
          </p>
        ) : null}
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
          <div className="flex flex-col items-start gap-3">
            <Alert variant="error">
              <AlertDescription>{KIN_DATES.loadFailed}. Check your connection.</AlertDescription>
            </Alert>
            <Button size="sm" variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
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
                weeks={kinDatesMonth(month, state.rows, names, now).weeks}
                onOpenKey={props.onOpenKey}
              />
            ) : state.rows.length === 0 ? (
              <KinWorkNotice {...KIN_DATES.none} />
            ) : (
              kinDatesAgenda(state.rows, names, now).map((day) => (
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
                    {day.rows.map((row) => (
                      <li key={row.id}>
                        <KinDateRow row={row} onOpen={props.onOpenKey} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const CELL_ROWS = 3;

function MonthGrid(props: {
  readonly weeks: ReturnType<typeof kinDatesMonth>["weeks"];
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
              {cell.rows.slice(0, CELL_ROWS).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  aria-label={row.accessibilityLabel}
                  onClick={() => props.onOpenKey(row.key)}
                  className={cn(
                    "truncate rounded-sm px-1 py-0.5 text-start text-xs outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset",
                    row.late
                      ? "text-destructive-foreground"
                      : row.closed
                        ? "text-muted-foreground line-through"
                        : "text-foreground",
                  )}
                >
                  {row.title}
                </button>
              ))}
              {cell.rows.length > CELL_ROWS ? (
                <span className="px-1 text-xs text-muted-foreground">
                  {cell.rows.length - CELL_ROWS} more
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
