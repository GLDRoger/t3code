// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import type { KinDateRow, KinDatesInput, KinDatesResult, KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import type { AtomCommandResult } from "../state/runtime.ts";
import { kinMoneyText, kinMonthLabel } from "./kinLists.ts";
import {
  kinWorkAllDay,
  kinWorkClosed,
  kinWorkDayOf,
  kinWorkDueLabel,
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

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const zoneClocks = new Map<string, Intl.DateTimeFormat | null>();

/** The first instant of `day` where the owner is, so a month there is a month here too. */
export function kinZonedDayStart(day: string, zone: string | null): Date {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  const local = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  if (zone === null) return local;
  let format = zoneClocks.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      format = null;
    }
    zoneClocks.set(zone, format);
  }
  if (format === null) return local;
  const wanted = Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  const wallAt = (instant: number) => {
    const parts = format.formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((held) => held.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  };
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

export function kinDateRowView(row: KinDateRow, names: KinWorkNames, now: Date): KinDateRowView {
  const { record } = row;
  const at = new Date(row.at);
  const day = kinWorkAllDay(row.at, true, names) ?? row.at.slice(0, 10);
  const closed = kinWorkClosed(record.state);
  const late = row.kind === "due" && record.late;
  const time = row.allDay || Number.isNaN(at.getTime()) ? null : clockFormat.format(at);
  const amount = record.amount === undefined ? null : kinMoneyText(record.amount);
  const state = row.stateLabel === row.label ? null : row.stateLabel;
  const line = [row.listName, row.label, state, record.party?.title ?? null]
    .filter((part) => part !== null)
    .join(" · ");
  const when = kinWorkDueLabel(day, new Date(`${kinOwnerToday(now, names)}T12:00:00`));
  return {
    id: `${record.key}:${row.kind}`,
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

export interface KinAgendaDay {
  readonly day: string;
  /** "Today", "Tomorrow", "Fri 14 Nov". */
  readonly label: string;
  readonly past: boolean;
  readonly rows: ReadonlyArray<KinDateRowView>;
}

/** Rows under the day they fall on, soonest first, as the host sent them. */
export function kinDatesAgenda(
  rows: ReadonlyArray<KinDateRow>,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinAgendaDay> {
  const today = kinOwnerToday(now, names);
  const days = new Map<string, Array<KinDateRowView>>();
  for (const row of rows) {
    const view = kinDateRowView(row, names, now);
    days.set(view.day, [...(days.get(view.day) ?? []), view]);
  }
  return [...days].map(([day, held]) => ({
    day,
    label: held[0]?.when ?? day,
    past: day < today,
    rows: held,
  }));
}

export interface KinMonthCell {
  readonly day: string;
  readonly number: number;
  readonly inMonth: boolean;
  readonly today: boolean;
  readonly rows: ReadonlyArray<KinDateRowView>;
}

export const KIN_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A month as whole weeks from Monday, each day holding what falls on it. */
export function kinDatesMonth(
  month: string,
  rows: ReadonlyArray<KinDateRow>,
  names: KinWorkNames,
  now: Date,
): { readonly label: string; readonly weeks: ReadonlyArray<ReadonlyArray<KinMonthCell>> } {
  const today = kinOwnerToday(now, names);
  const byDay = new Map<string, Array<KinDateRowView>>();
  for (const row of rows) {
    const view = kinDateRowView(row, names, now);
    byDay.set(view.day, [...(byDay.get(view.day) ?? []), view]);
  }
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
    weeks.at(-1)!.push({
      day,
      number: date.getDate(),
      inMonth,
      today: day === today,
      rows: byDay.get(day) ?? [],
    });
  }
  return { label: kinMonthLabel(month), weeks };
}
