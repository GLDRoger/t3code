import type { KinRepeatRule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { dayIn } from "./money.ts";
import { endOfDay, type StoredRepeat } from "./recordRows.ts";

/**
 * When a repeating entry's next one falls: a month, quarter or year on from each of its dates,
 * on the day of the month it started on (or that month's last), or a number of days on. Whole
 * days stay whole days in the owner's zone; a time keeps its wall-clock time there.
 */

const MONTHS = { month: 1, quarter: 3, year: 12 } as const;
const daysIn = (year: number, month: number) =>
  DateTime.toPartsUtc(DateTime.endOf(DateTime.makeUnsafe({ year, month, day: 1 }), "month")).day;

const shiftParts = (
  parts: { readonly year: number; readonly month: number; readonly day: number },
  rule: KinRepeatRule,
  anchorDay: number | undefined,
) => {
  if (rule.every === "days") {
    const next = DateTime.toPartsUtc(
      DateTime.add(DateTime.makeUnsafe({ year: parts.year, month: parts.month, day: parts.day }), {
        days: rule.days,
      }),
    );
    return { year: next.year, month: next.month, day: next.day };
  }
  const index = parts.year * 12 + parts.month - 1 + MONTHS[rule.every];
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month, day: Math.min(anchorDay ?? parts.day, daysIn(year, month)) };
};

const shift = (
  ms: number,
  allDay: boolean,
  rule: KinRepeatRule,
  anchorDay: number | undefined,
  zone: string,
) => {
  if (allDay) {
    const [year, month, day] = dayIn(ms, zone)
      .split("-")
      .map((part) => Number.parseInt(part, 10));
    const next = shiftParts({ year: year!, month: month!, day: day! }, rule, anchorDay);
    return endOfDay(
      `${next.year}-${String(next.month).padStart(2, "0")}-${String(next.day).padStart(2, "0")}`,
      zone,
    );
  }
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(ms, { timeZone: zone }));
  const next = shiftParts(parts, rule, anchorDay);
  return DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe({ ...parts, ...next }, { timeZone: zone, adjustForTimeZone: true }),
  );
};

/** The day of the month a date is on in `zone`, which later months keep where they can. */
export const anchorOf = (ms: number | null, zone: string) =>
  ms === null ? undefined : Number.parseInt(dayIn(ms, zone).slice(8, 10), 10);

export const nextDates = (
  repeat: StoredRepeat,
  dates: {
    readonly dueAt: number | null;
    readonly dueAllDay: boolean;
    readonly dateAt: number | null;
    readonly dateAllDay: boolean;
  },
  zone: string,
) => ({
  dueAt:
    dates.dueAt === null
      ? null
      : shift(dates.dueAt, dates.dueAllDay, repeat.rule, repeat.dueDay, zone),
  dateAt:
    dates.dateAt === null
      ? null
      : shift(dates.dateAt, dates.dateAllDay, repeat.rule, repeat.dateDay, zone),
});
