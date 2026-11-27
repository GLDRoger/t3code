// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import { kinDateRowLate, kinWhenParts } from "@t3tools/contracts";
import type {
  KinCalendarEvent,
  KinCalendarSource,
  KinDateRow,
  KinDatesInput,
  KinDatesResult,
  KinRecordKey,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  kinCalendarPlace,
  type KinCalendarPlaced,
  type KinCalendarRowView,
} from "./kinCalendar.ts";
import { kinMoneyText, kinMonthLabel, kinSuggestionText } from "./kinLists.ts";
import {
  kinWorkAllDay,
  kinWorkClock,
  kinWorkClosed,
  kinWorkDayOf,
  kinWorkDueLabel,
  kinWorkDueZone,
  type KinWorkNames,
} from "./kinWork.ts";

/** Everything with a date, whatever list it is in: an agenda by day, and a month to look across. */

export const KIN_DATES = {
  title: "All dates",
  summary: "Everything due or dated, across every list",
  loadFailed: "Couldn't load your dates",
  agenda: "Agenda",
  month: "Month",
  openOnly: "Only what's open",
  none: {
    title: "Nothing with a date here",
    detail:
      "Entries with a due date or a date of their own show up here, whatever list they're in.",
  },
  more: "There is more than fits here. Narrow it to what's open, or look at one month.",
  overdue: "Overdue",
  previous: "Previous month",
  next: "Next month",
  today: "Today",
};

/** How far back and ahead the agenda looks. */
const KIN_DATES_BEHIND_DAYS = 30;
const KIN_DATES_AHEAD_DAYS = 90;
const READ_CAP = 400;

/** The first instant of `day` where the owner is, so a month there is a month here too. */
export function kinZonedDayStart(day: string, zone: string | null): Date {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  const local = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  if (zone === null) return local;
  const wanted = Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  const wallAt = (instant: number) => {
    const part = kinWhenParts(instant, zone);
    return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute);
  };
  try {
    wallAt(wanted);
  } catch {
    return local;
  }
  // The zone's offset at the guess, applied twice so a clock change that day still lands right.
  let instant = wanted - (wallAt(wanted) - wanted);
  instant = wanted - (wallAt(instant) - instant);
  return new Date(instant);
}

const shiftDay = (day: string, days: number) => {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  return kinWorkDayOf(new Date(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + days));
};

/** Today where the owner is. */
export const kinOwnerToday = (now: Date, names: KinWorkNames) =>
  kinWorkAllDay(now.toISOString(), true, names) ?? kinWorkDayOf(now);

/** Today for whoever is reading, which heads the agenda and marks the month, as Tasks counts it. */
const kinReaderToday = (now: Date, names: KinWorkNames) =>
  kinOwnerToday(now, { ...names, zone: names.readerZone ?? names.zone });

export const kinShiftMonth = (month: string, by: number) => {
  const at = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1);
  return kinWorkDayOf(at).slice(0, 7);
};

export interface KinDatesWindow {
  readonly from: string;
  readonly to: string;
}

/** The agenda's window: a month back for what slipped, three ahead for what is coming. */
export const kinAgendaWindow = (today: string, zone: string | null): KinDatesWindow => ({
  from: kinZonedDayStart(shiftDay(today, -KIN_DATES_BEHIND_DAYS), zone).toISOString(),
  to: kinZonedDayStart(shiftDay(today, KIN_DATES_AHEAD_DAYS + 1), zone).toISOString(),
});

export const kinMonthWindow = (month: string, zone: string | null): KinDatesWindow => ({
  from: kinZonedDayStart(`${month}-01`, zone).toISOString(),
  to: kinZonedDayStart(`${kinShiftMonth(month, 1)}-01`, zone).toISOString(),
});

/** Reads a window a page at a time, up to a cap that says so when it is reached. */
export async function kinReadDates(
  read: (input: KinDatesInput) => Promise<AtomCommandResult<KinDatesResult, unknown>>,
  input: KinDatesInput,
): Promise<
  AtomCommandResult<{ readonly rows: ReadonlyArray<KinDateRow>; readonly more: boolean }, unknown>
> {
  const rows: Array<KinDateRow> = [];
  let cursor: string | null = null;
  do {
    const result = await read({ ...input, limit: 200, ...(cursor === null ? {} : { cursor }) });
    if (!AsyncResult.isSuccess(result)) return AsyncResult.failure(result.cause);
    rows.push(...result.value.rows);
    cursor = result.value.nextCursor;
  } while (cursor !== null && rows.length < READ_CAP);
  return AsyncResult.success({ rows, more: cursor !== null });
}

export interface KinDateRowView {
  /** An entry with both a due date and its own date is on the list twice. */
  readonly id: string;
  readonly key: KinRecordKey;
  /** The day it falls on where the owner is. */
  readonly day: string;
  /** "Today", "Fri 14 Nov". */
  readonly when: string;
  readonly title: string;
  /** "Dates · Due · To file". */
  readonly line: string;
  /** "5:30 PM" for a timed one. */
  readonly time: string | null;
  readonly amount: string | null;
  readonly late: boolean;
  readonly closed: boolean;
  readonly accessibilityLabel: string;
}

function kinDateRowView(row: KinDateRow, names: KinWorkNames, now: Date): KinDateRowView {
  const { record } = row;
  const at = new Date(row.at);
  // A timed row files on the reader's day and clock, as Tasks shows it; an all-day one on the company's.
  const zone = kinWorkDueZone(row.allDay, names);
  const day = kinWorkAllDay(row.at, true, { zone }) ?? row.at.slice(0, 10);
  const closed = kinWorkClosed(record.state);
  const late = kinDateRowLate(row);
  const time = row.allDay || Number.isNaN(at.getTime()) ? null : kinWorkClock(at, zone);
  const amount = record.amount === undefined ? null : kinMoneyText(record.amount);
  const stateLabel = kinSuggestionText(record, row.stateLabel);
  const state = stateLabel === row.label ? null : stateLabel;
  const line = [row.listName, row.label, state, record.party?.title ?? null]
    .filter((part) => part !== null)
    .join(" · ");
  const when = kinWorkDueLabel(day, new Date(`${kinOwnerToday(now, { ...names, zone })}T12:00:00`));
  return {
    id: `${record.key}:${row.field ?? row.kind}`,
    key: record.key,
    day,
    when,
    title: record.title,
    line,
    time,
    amount,
    late,
    closed,
    accessibilityLabel: [record.title, when, line, time, amount, late ? KIN_DATES.overdue : null]
      .filter((part) => part !== null)
      .join(". "),
  };
}

/** A day's Work row or calendar event, in the order the day shows them. */
export type KinDatesEntry =
  | { readonly kind: "work"; readonly id: string; readonly row: KinDateRowView }
  | { readonly kind: "event"; readonly id: string; readonly event: KinCalendarRowView };

/** Calendar events to show among Work's rows; the date pickers pass none. */
export interface KinDatesCalendar {
  readonly sources: ReadonlyArray<KinCalendarSource>;
  readonly events: ReadonlyArray<KinCalendarEvent>;
}

interface WorkHeld {
  readonly view: KinDateRowView;
  readonly allDay: boolean;
  readonly at: number;
}

const placeEvents = (
  calendar: KinDatesCalendar | undefined,
  names: KinWorkNames,
  today: string,
): ReadonlyArray<KinCalendarPlaced> => {
  if (calendar === undefined) return [];
  const sources = new Map(calendar.sources.map((source) => [source.connectionId, source]));
  return calendar.events.flatMap((event) => {
    const placed = kinCalendarPlace(event, sources.get(event.connectionId), names, today);
    return placed === null ? [] : [placed];
  });
};

/** All-day first (Work, then events), then timed ones by time; Work keeps the host's order. */
function dayEntries(
  work: ReadonlyArray<WorkHeld>,
  events: ReadonlyArray<KinCalendarRowView>,
): ReadonlyArray<KinDatesEntry> {
  const workEntry = (held: WorkHeld): KinDatesEntry => ({
    kind: "work",
    id: held.view.id,
    row: held.view,
  });
  const eventEntry = (event: KinCalendarRowView): KinDatesEntry => ({
    kind: "event",
    id: event.id,
    event,
  });
  const timedWork = work.filter((held) => !held.allDay);
  const timedEvents = events.filter((event) => !event.allDay).sort((a, b) => a.at - b.at);
  const entries: Array<KinDatesEntry> = [
    ...work.filter((held) => held.allDay).map(workEntry),
    ...events.filter((event) => event.allDay).map(eventEntry),
  ];
  let w = 0;
  let e = 0;
  while (w < timedWork.length || e < timedEvents.length) {
    const nextWork = timedWork[w];
    const nextEvent = timedEvents[e];
    if (nextWork !== undefined && (nextEvent === undefined || nextWork.at <= nextEvent.at)) {
      entries.push(workEntry(nextWork));
      w += 1;
    } else if (nextEvent !== undefined) {
      entries.push(eventEntry(nextEvent));
      e += 1;
    }
  }
  return entries;
}

const workByDay = (rows: ReadonlyArray<KinDateRow>, names: KinWorkNames, now: Date) => {
  const days = new Map<string, Array<WorkHeld>>();
  for (const row of rows) {
    const view = kinDateRowView(row, names, now);
    days.set(view.day, [
      ...(days.get(view.day) ?? []),
      { view, allDay: row.allDay, at: Date.parse(row.at) },
    ]);
  }
  return days;
};

export interface KinAgendaDay {
  readonly day: string;
  /** "Today", "Tomorrow", "Fri 14 Nov". */
  readonly label: string;
  readonly past: boolean;
  /** Work's rows alone, as the host sent them. */
  readonly rows: ReadonlyArray<KinDateRowView>;
  readonly entries: ReadonlyArray<KinDatesEntry>;
}

/**
 * Rows under the day they fall on, soonest day first, each day's rows as the host sent them. An
 * event spanning days shows once, on its first day in view.
 */
export function kinDatesAgenda(
  rows: ReadonlyArray<KinDateRow>,
  names: KinWorkNames,
  now: Date,
  calendar?: KinDatesCalendar,
): ReadonlyArray<KinAgendaDay> {
  const today = kinReaderToday(now, names);
  const work = workByDay(rows, names, now);
  const agendaFirst = shiftDay(kinOwnerToday(now, names), -KIN_DATES_BEHIND_DAYS);
  const events = new Map<string, Array<KinCalendarRowView>>();
  for (const placed of placeEvents(calendar, names, today)) {
    const day =
      placed.first < agendaFirst && placed.last >= agendaFirst ? agendaFirst : placed.first;
    events.set(day, [...(events.get(day) ?? []), placed.on(day)]);
  }
  return [...new Set([...work.keys(), ...events.keys()])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((day) => {
      const held = work.get(day) ?? [];
      return {
        day,
        label: kinWorkDueLabel(day, new Date(`${today}T12:00:00`)),
        past: day < today,
        rows: held.map((one) => one.view),
        entries: dayEntries(held, events.get(day) ?? []),
      };
    });
}

export interface KinMonthCell {
  readonly day: string;
  readonly number: number;
  readonly inMonth: boolean;
  readonly today: boolean;
  /** Work's rows alone. */
  readonly rows: ReadonlyArray<KinDateRowView>;
  readonly entries: ReadonlyArray<KinDatesEntry>;
}

export const KIN_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A month as whole weeks from Monday, each day holding what falls on it. */
export function kinDatesMonth(
  month: string,
  rows: ReadonlyArray<KinDateRow>,
  names: KinWorkNames,
  now: Date,
  calendar?: KinDatesCalendar,
): { readonly label: string; readonly weeks: ReadonlyArray<ReadonlyArray<KinMonthCell>> } {
  const today = kinReaderToday(now, names);
  const work = workByDay(rows, names, now);
  const events = placeEvents(calendar, names, today);
  const first = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const weeks: Array<Array<KinMonthCell>> = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(first.getFullYear(), first.getMonth(), 1 - lead + index);
    const day = kinWorkDayOf(date);
    const inMonth = day.startsWith(month);
    // A sixth week that is all next month isn't drawn.
    if (index % 7 === 0 && index >= 28 && !inMonth) break;
    if (index % 7 === 0) weeks.push([]);
    const held = work.get(day) ?? [];
    weeks.at(-1)!.push({
      day,
      number: date.getDate(),
      inMonth,
      today: day === today,
      rows: held.map((one) => one.view),
      entries: dayEntries(
        held,
        events
          .filter((placed) => placed.first <= day && day <= placed.last)
          .map((placed) => placed.on(day)),
      ),
    });
  }
  return { label: kinMonthLabel(month), weeks };
}
