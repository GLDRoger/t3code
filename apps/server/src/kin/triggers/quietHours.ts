import { kinWhenParts, KinWorkHours } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MINUTE_MS } from "../durations.ts";

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

/** Whether `now` falls inside the hours, in their time zone. */
export const workingAt = (hours: KinWorkHours, timeZone: string, now: number) => {
  const parts = kinWhenParts(now, timeZone);
  const day = DAYS.indexOf(parts.weekday as (typeof DAYS)[number]);
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return hours.days.includes(day) && time >= hours.start && time < hours.end;
};

/**
 * When Kin holds an unprompted line to one person: their quiet hours, and, when they hold
 * non-urgent messages outside their working hours (`hours` set), any time outside those. All on
 * their own clock (`zone`).
 */
export type KinHoldRule = {
  readonly zone: string;
  readonly quiet: KinQuietHours;
  readonly hours?: KinWorkHours | undefined;
  /** While they are away: the first millisecond of the day they are back. */
  readonly awayUntil?: number | undefined;
};

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * The rule for one person. Working hours that never fall outside their quiet hours (or name no
 * day) would hold every line for good, so then only quiet hours hold.
 */
export const holdRule = (
  zone: string,
  quiet: KinQuietHours,
  hours: KinWorkHours | undefined,
): KinHoldRule => {
  if (hours === undefined || hours.days.length === 0) return { zone, quiet };
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  for (let minute = minutesOf(hours.start); minute < minutesOf(hours.end); minute += 1) {
    const inQuiet =
      from < to ? minute >= from && minute < to : from > to && (minute >= from || minute < to);
    if (!inQuiet) return { zone, quiet, hours };
  }
  return { zone, quiet };
};

/** Why a line to them waits at `at`, or undefined when it goes now. */
export const heldAt = (rule: KinHoldRule, at: number): "quiet" | "off" | "away" | undefined =>
  rule.awayUntil !== undefined && at < rule.awayUntil
    ? "away"
    : isQuiet(at, rule.zone, rule.quiet)
      ? "quiet"
      : rule.hours !== undefined && !workingAt(rule.hours, rule.zone, at)
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
