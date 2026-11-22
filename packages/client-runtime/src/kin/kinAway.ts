// @effect-diagnostics globalDate:off - Pure view helpers format days and times for React render, outside an Effect runtime.
import { kinNow } from "./kinNow.ts";
import { kinWhenFormat, formatKinWhen, kinWhenParts } from "@t3tools/contracts";
import type { KinMessage, KinMessageWhen, KinPersonProfile } from "@t3tools/contracts";

import { kinSameTimeZone, kinZoneLabel } from "./kinTimeZone.ts";

/** "Away until <day>" on a profile: what Kin holds meanwhile, and the way back. */
export const KIN_AWAY = {
  label: "Away",
  notAway: "Not set",
  set: "Set away…",
  change: "Change",
  back: "I'm back",
  title: "Away until",
  mineHint:
    "Kin holds messages that can wait until the day you're back, as it does outside your working hours. Agents see it and plan around it. Something urgent still reaches you.",
  theirHint: (name: string) =>
    `Kin holds messages that can wait until the day ${name} is back. Agents see it and plan around it.`,
  dayLabel: "Back on",
  save: "Save",
  /** Web's form submit: the action, beside "I'm back". */
  setSubmit: "Set away",
  saving: "Saving…",
  notAfterToday: "Pick a day after today.",
  failed: "Couldn't save that.",
} as const;

const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
};

/** Today on `zone`'s calendar, as YYYY-MM-DD. */
const kinDayIn = (now: Date, zone: string | null) => {
  try {
    return kinWhenParts(now, zone ?? deviceZone()).isoDay;
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/** "Thu 19 Nov", or with its year when not this one. */
export const kinAwayDay = (day: string, now: Date = kinNow()) => {
  const [year, month, date] = day.split("-").map(Number);
  const at = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12));
  return formatKinWhen(at, year === now.getFullYear() ? "day" : "dayYear", { zone: "UTC" }).replace(
    /,/g,
    "",
  );
};

/**
 * Who is away and until when, true for this reader: the day is on the away person's calendar, so
 * a reader on another clock is told whose. `short` is for a row already titled Away. Null when
 * they aren't away.
 */
export function kinAwayLine(
  profile: Pick<KinPersonProfile, "awayUntil" | "timeZone" | "displayName">,
  reader: {
    readonly mine: boolean;
    readonly short?: boolean;
    readonly zone?: string;
    readonly now?: Date;
  },
): string | null {
  if (profile.awayUntil === undefined) return null;
  const day = kinAwayDay(profile.awayUntil, reader.now);
  const theirs =
    profile.timeZone === null || kinSameTimeZone(profile.timeZone, reader.zone ?? deviceZone())
      ? ""
      : ` (${kinZoneLabel(profile.timeZone)})`;
  if (reader.short === true) return `Until ${day}${theirs}`;
  return reader.mine ? `You're away until ${day}${theirs}` : `Away until ${day}${theirs}`;
}

/** The day picker's first value: a week from today on their calendar. */
export const kinAwayDefault = (now: Date, zone: string | null) => {
  const today = kinDayIn(now, zone);
  const [year, month, date] = today.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + 7))
    .toISOString()
    .slice(0, 10);
};

/** A day to be back on, or why not: it must come after today on their calendar. */
export function kinAwayProblem(day: string, now: Date, zone: string | null): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day > kinDayIn(now, zone)
    ? null
    : KIN_AWAY.notAfterToday;
}

const timeIn = (at: Date, zone: string) => kinWhenFormat("time", { zone }).format(at);
const dayIn = (at: Date, zone: string) =>
  kinWhenFormat("day", { zone }).format(at).replace(/,/g, "");

/**
 * A time a message names, on the reader's clock: as written when they share its zone, else
 * "04:30 your time (Tue 17 Nov), 10:00 for Zoya Sheikh".
 */
export function kinWhenText(when: KinMessageWhen, readerZone: string = deviceZone()): string {
  if (kinSameTimeZone(when.zone, readerZone)) return when.text;
  const at = new Date(when.at);
  const mine = `${timeIn(at, readerZone)} your time (${dayIn(at, readerZone)})`;
  return when.of === undefined ? mine : `${mine}, ${timeIn(at, when.zone)} for ${when.of}`;
}

/** Kin's note in the asking chat when a request waits for the person it went to (`arrivesNote`). */
const ARRIVES_NOTE = "kin-arrives:";

/**
 * Who will see the request and when, on their clock: "Rhea Kapoor will see your request at
 * 7:00 AM (Sat Nov 21).", and on another clock also when that is for the reader.
 */
export function kinArrivesText(
  when: KinMessageWhen & { readonly of: string },
  readerZone: string = deviceZone(),
): string {
  const at = new Date(when.at);
  const day = dayIn(at, when.zone);
  if (kinSameTimeZone(when.zone, readerZone))
    return `${when.of} will see your request at ${timeIn(at, when.zone)} (${day}).`;
  const myDay = dayIn(at, readerZone);
  const mine = `${timeIn(at, readerZone)} your time${myDay === day ? "" : ` (${myDay})`}`;
  return `${when.of} will see your request at ${timeIn(at, when.zone)} their time (${day}), ${mine}.`;
}

/** The message as this reader reads it: a time it names, on their own clock. */
export function kinMessageOnMyClock(message: KinMessage, readerZone?: string): KinMessage {
  const when = message.when;
  if (when === undefined) return message;
  if (message.messageId.startsWith(ARRIVES_NOTE) && when.of !== undefined)
    return { ...message, body: kinArrivesText({ ...when, of: when.of }, readerZone) };
  if (!message.body.includes(when.text)) return message;
  const text = kinWhenText(when, readerZone);
  return text === when.text ? message : { ...message, body: message.body.replace(when.text, text) };
}
