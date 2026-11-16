import type { KinWorkHours } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const formats = new Map<string, Intl.DateTimeFormat>();
const formatIn = (timeZone: string) => {
  const known = formats.get(timeZone);
  if (known !== undefined) return known;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formats.set(timeZone, made);
  return made;
};

/** Whether `now` falls inside the hours, in their time zone. */
export const workingAt = (hours: KinWorkHours, timeZone: string, now: number) => {
  const parts = formatIn(timeZone).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const day = DAYS.indexOf(part("weekday") as (typeof DAYS)[number]);
  const time = `${part("hour")}:${part("minute")}`;
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
export const heldAt = (rule: KinHoldRule, at: number): "quiet" | "off" | undefined =>
  isQuiet(at, rule.zone, rule.quiet)
    ? "quiet"
    : rule.hours !== undefined && !workingAt(rule.hours, rule.zone, at)
      ? "off"
      : undefined;

const MINUTE = 60_000;
const STEP = 5 * MINUTE;
const SCAN = 8 * 24 * 60 * MINUTE;

/**
 * The first whole minute at or after `now` when a line to them goes; `now` itself when it goes
 * now. Hours that never fall outside quiet hours within eight days leave only quiet hours.
 */
export const freeAt = (rule: KinHoldRule, now: number): number => {
  if (heldAt(rule, now) === undefined) return now;
  const start = Math.ceil(now / MINUTE) * MINUTE;
  for (let at = start; at < start + SCAN; at += STEP) {
    if (heldAt(rule, at) !== undefined) continue;
    let first = at;
    while (first - MINUTE >= start && first - MINUTE > at - STEP && !heldAt(rule, first - MINUTE))
      first -= MINUTE;
    return first;
  }
  return rule.hours === undefined ? start : freeAt({ zone: rule.zone, quiet: rule.quiet }, now);
};
