import { kinWhenParts, KinWorkHours } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DAY_MS, MINUTE_MS } from "../durations.ts";

export type KinQuietHours = { readonly from: string; readonly to: string };

/** Used until the owner sets their own in Kin's settings: nothing unprompted from 22:00 to 07:00. */
export const KIN_DEFAULT_QUIET_HOURS: KinQuietHours = { from: "22:00", to: "07:00" };

/** Whether `now` falls in `hours` on the wall clock of `zone`; `from` after `to` spans midnight. */
export function isQuiet(now: number, zone: string, hours: KinQuietHours) {
  const p = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone }));
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return hours.from < hours.to
    ? time >= hours.from && time < hours.to
    : hours.from > hours.to && (time >= hours.from || time < hours.to);
}

/** Whether someone away until `day` (their calendar) still is at `now`, on their clock. */
export const stillAway = (day: string | null | undefined, zone: string, now: number) =>
  day != null && day > DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now, { timeZone: zone }));

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MINUTES = 24 * 60;
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Hours covering every minute of every day say nothing about when someone works: no hours. */
export const wholeDay = (hours: KinWorkHours) =>
  DAYS.every((_, day) => hours.days.includes(day)) &&
  hours.start === "00:00" &&
  hours.end >= "23:59";

const decodeHours = Schema.decodeUnknownOption(Schema.fromJsonString(KinWorkHours));

/** A person's `work_hours_json` as hours, or undefined when unset, unreadable or whole-day. */
export const storedWorkHours = (json: string | null | undefined) =>
  json == null
    ? undefined
    : Option.getOrUndefined(Option.filter(decodeHours(json), (hours) => !wholeDay(hours)));

const timeOf = (parts: { readonly hour: number; readonly minute: number }) =>
  `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;

/**
 * Whether `now` falls inside the hours, in their time zone. `start` after `end` is a shift that
 * runs past midnight: it starts on each of `days` and ends the next morning.
 */
export const workingAt = (hours: KinWorkHours, timeZone: string, now: number) => {
  const parts = kinWhenParts(now, timeZone);
  const day = DAYS.indexOf(parts.weekday as (typeof DAYS)[number]);
  const time = timeOf(parts);
  return hours.start < hours.end
    ? hours.days.includes(day) && time >= hours.start && time < hours.end
    : hours.start > hours.end &&
        ((hours.days.includes(day) && time >= hours.start) ||
          (hours.days.includes((day + 6) % 7) && time < hours.end));
};

/** `time` on the calendar day `day` of `zone`. */
const onDay = (
  day: { readonly year: number; readonly month: number; readonly day: number },
  time: string,
  zone: string,
) =>
  DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      {
        year: day.year,
        month: day.month,
        day: day.day,
        hour: Math.floor(minutesOf(time) / 60),
        minute: minutesOf(time) % 60,
      },
      { timeZone: zone, adjustForTimeZone: true },
    ),
  );

/** The first `time` on one of `days` strictly after `after`, on `zone`'s clock, within 15 days. */
const nextOnDays = (after: number, zone: string, time: string, days: ReadonlyArray<number>) => {
  // Noon steps from day to day without a daylight-saving change skipping or repeating one.
  let noon = onDay(kinWhenParts(after, zone), "12:00", zone);
  for (let step = 0; step < 15; step++, noon += DAY_MS) {
    const day = kinWhenParts(noon, zone);
    const at = onDay(day, time, zone);
    if (at > after && days.includes(DAYS.indexOf(day.weekday as (typeof DAYS)[number]))) return at;
  }
  return undefined;
};

/** When the hours next start, strictly after `after`, on their clock. */
export const hoursStartAfter = (hours: KinWorkHours, zone: string, after: number) =>
  nextOnDays(after, zone, hours.start, hours.days);

/**
 * The end of the stretch of hours `after` falls in, else of the next one, on their clock. A shift
 * that runs past midnight ends on the day after each of its days.
 */
export const hoursEndAfter = (hours: KinWorkHours, zone: string, after: number) =>
  nextOnDays(
    after,
    zone,
    hours.end,
    hours.start > hours.end ? hours.days.map((day) => (day + 1) % 7) : hours.days,
  );

/**
 * When Kin holds an unprompted line to one person: their quiet hours, and, when they hold
 * non-urgent messages outside their working hours (`hours` set), any time outside those. All on
 * their own clock (`zone`).
 */
export type KinHoldRule = {
  readonly zone: string;
  readonly quiet: KinQuietHours;
  readonly hours?: KinWorkHours | undefined;
  /** The clock `hours` are on when it is not `zone`'s: the owner's own, as quiet hours keep the company's. */
  readonly hoursZone?: string | undefined;
  /** While they are away: the first millisecond of the day they are back. */
  readonly awayUntil?: number | undefined;
};

/** Minutes `zone`'s wall clock is ahead of UTC at `at`. */
const offsetAt = (zone: string, at: number) => {
  const p = kinWhenParts(at, zone);
  const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - minute) / MINUTE_MS;
};

/**
 * The rule for one person. Working hours that never fall outside their quiet hours (or name no
 * day) would hold every line for good, so then only quiet hours hold. Hours on another clock
 * (`own`) are compared with quiet hours at the two clocks' offsets at `own.at`.
 */
export const holdRule = (
  zone: string,
  quiet: KinQuietHours,
  hours: KinWorkHours | undefined,
  own?: { readonly zone: string; readonly at: number },
): KinHoldRule => {
  if (hours === undefined || hours.days.length === 0) return { zone, quiet };
  const hoursZone = own === undefined || own.zone === zone ? undefined : own.zone;
  const shift =
    own === undefined || hoursZone === undefined
      ? 0
      : offsetAt(zone, own.at) - offsetAt(hoursZone, own.at);
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  const start = minutesOf(hours.start);
  // A shift past midnight wraps; `start` equal to `end` is no minutes.
  const length = (minutesOf(hours.end) - start + DAY_MINUTES) % DAY_MINUTES;
  for (let step = 0; step < length; step += 1) {
    const minute = (((start + step + shift) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    const inQuiet =
      from < to ? minute >= from && minute < to : from > to && (minute >= from || minute < to);
    if (!inQuiet) return { zone, quiet, hours, ...(hoursZone === undefined ? {} : { hoursZone }) };
  }
  return { zone, quiet };
};

/** Why a line to them waits at `at`, or undefined when it goes now. */
export const heldAt = (rule: KinHoldRule, at: number): "quiet" | "off" | "away" | undefined =>
  rule.awayUntil !== undefined && at < rule.awayUntil
    ? "away"
    : isQuiet(at, rule.zone, rule.quiet)
      ? "quiet"
      : rule.hours !== undefined && !workingAt(rule.hours, rule.hoursZone ?? rule.zone, at)
        ? "off"
        : undefined;

const STEP = 5 * MINUTE_MS;
const SCAN = 8 * 24 * 60 * MINUTE_MS;

/**
 * The first whole minute at or after `now` when a line to them goes; `now` itself when it goes
 * now. Hours that never fall outside quiet hours within eight days leave only quiet hours.
 */
export const freeAt = (rule: KinHoldRule, now: number): number => {
  if (rule.awayUntil !== undefined && now < rule.awayUntil)
    return freeAt({ ...rule, awayUntil: undefined }, rule.awayUntil);
  if (heldAt(rule, now) === undefined) return now;
  const start = Math.ceil(now / MINUTE_MS) * MINUTE_MS;
  for (let at = start; at < start + SCAN; at += STEP) {
    if (heldAt(rule, at) !== undefined) continue;
    let first = at;
    while (
      first - MINUTE_MS >= start &&
      first - MINUTE_MS > at - STEP &&
      !heldAt(rule, first - MINUTE_MS)
    )
      first -= MINUTE_MS;
    return first;
  }
  return rule.hours === undefined ? start : freeAt({ zone: rule.zone, quiet: rule.quiet }, now);
};
