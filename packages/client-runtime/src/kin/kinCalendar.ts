// @effect-diagnostics globalDate:off - Pure view helpers format calendar times for React render, outside an Effect runtime.
import type {
  KinCalendarEvent,
  KinCalendarSource,
  KinMineCalendarResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import type { AtomCommandResult } from "../state/runtime.ts";
import { kinHostLacksCall } from "./kinHost.ts";
import {
  kinWorkAllDay,
  kinWorkClock,
  kinWorkDayOf,
  kinWorkDueLabel,
  kinWorkDueZone,
  type KinWorkNames,
} from "./kinWork.ts";

/** A person's own calendars, and the company's for owner level, beside Work dates. Read only. */

export const KIN_CALENDAR = {
  toggle: "Calendar events",
  untitled: "(No title)",
  repeats: "Repeats",
  loading: "Loading your calendar…",
  loadFailed: "Couldn't load your calendar. Your Work dates are all here.",
  notConnected:
    "Connect your calendar under Settings → Connections → Your mailboxes to see its events here.",
  more: "Some events don't fit here. Your calendar has them all.",
};

const SERVICE = { google: "Google Calendar", microsoft: "Outlook" } as const;
const MAILBOX = { google: "Google mailbox", microsoft: "Microsoft mailbox" } as const;

/** Both vendors' all-day end is the day after the last one. */
const nextDay = (day: string, by: number) => {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  return kinWorkDayOf(new Date(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + by));
};

const httpsOnly = (link: string | null) => {
  if (link === null) return null;
  try {
    return new URL(link).protocol === "https:" ? link : null;
  } catch {
    return null;
  }
};

const zonePlace = (zone: string) => zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;

const sinceWord = (label: string) =>
  label === "Today" || label === "Tomorrow" || label === "Yesterday" ? label.toLowerCase() : label;

export interface KinCalendarRowView {
  readonly id: string;
  /** The day it is filed under: the reader's for a timed one, its own date for an all-day one. */
  readonly day: string;
  /** "Today", "Fri 14 Nov". */
  readonly when: string;
  readonly title: string;
  /** "3:00 PM · 10:30 AM New York · rhea@tidewater.example · Repeats". */
  readonly line: string;
  /** The reader's clock for a timed one. */
  readonly time: string | null;
  readonly allDay: boolean;
  /** Its start, for ordering among Work's timed rows. */
  readonly at: number;
  /** The provider's own page, https only; with none the row opens nothing. */
  readonly link: string | null;
  readonly accessibilityLabel: string;
}

/** Where an event falls: the days it covers, and how it is drawn on one of them. */
export interface KinCalendarPlaced {
  readonly first: string;
  readonly last: string;
  readonly on: (day: string) => KinCalendarRowView;
}

export function kinCalendarPlace(
  event: KinCalendarEvent,
  source: KinCalendarSource | undefined,
  names: KinWorkNames,
  today: string,
): KinCalendarPlaced | null {
  const title = event.title?.trim() || KIN_CALENDAR.untitled;
  const service = source?.service ?? "google";
  const account = source?.account ?? null;
  const link = httpsOnly(event.link);
  const label = (day: string) => kinWorkDueLabel(day, new Date(`${today}T12:00:00`));
  let first: string;
  let last: string;
  let time: string | null = null;
  let own: string | null = null;
  let until: (day: string) => string | null;
  let at: number;
  if (event.allDay) {
    // A date, not an instant: no zone ever moves it.
    first = event.start.slice(0, 10);
    const end = event.end?.slice(0, 10) ?? nextDay(first, 1);
    last = end > first ? nextDay(end, -1) : first;
    until = (day) => (last > day ? `until ${sinceWord(label(last))}` : null);
    at = Date.parse(`${first}T00:00:00.000Z`);
  } else {
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) return null;
    const zone = kinWorkDueZone(false, names);
    first = kinWorkAllDay(event.start, true, { zone }) ?? event.start.slice(0, 10);
    last = first;
    time = kinWorkClock(start, zone);
    if (event.zone !== null) {
      const there = kinWorkClock(start, event.zone);
      if (there !== time) own = `${there} ${zonePlace(event.zone)}`;
    }
    const end = event.end === null ? null : new Date(event.end);
    const endDay =
      end === null || Number.isNaN(end.getTime()) ? null : kinWorkAllDay(event.end, true, { zone });
    until = () =>
      end !== null && endDay !== null && endDay > first
        ? `until ${sinceWord(label(endDay))}, ${kinWorkClock(end, zone)}`
        : null;
    at = start.getTime();
  }
  return {
    first,
    last,
    on: (day) => {
      const when = label(day);
      const line = [time, own, until(day), account, event.repeats ? KIN_CALENDAR.repeats : null]
        .filter((part) => part !== null)
        .join(" · ");
      return {
        id: `${event.connectionId}:${event.id}`,
        day,
        when,
        title,
        line,
        time,
        allDay: event.allDay,
        at,
        link,
        accessibilityLabel: [
          title,
          when,
          line,
          link === null ? null : `Opens in ${SERVICE[service]}`,
        ]
          .filter((part) => part !== null && part !== "")
          .join(". "),
      };
    },
  };
}

export type KinCalendarState =
  | { readonly _tag: "off" }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | {
      readonly _tag: "ready";
      readonly calendar: KinMineCalendarResult;
      /** The last window's events stay up while the next one is read. */
      readonly refreshing: boolean;
    };

/** What one read answered, for the screen it was asked for (`scope`) and the window (`request`). */
export type KinCalendarHeld =
  | {
      readonly scope: string;
      readonly request: string;
      readonly outcome: "ready";
      readonly calendar: KinMineCalendarResult;
    }
  | {
      readonly scope: string;
      readonly request: string;
      readonly outcome: "failed" | "unavailable";
    };

export function kinCalendarHeld(
  scope: string,
  request: string,
  result: AtomCommandResult<KinMineCalendarResult, unknown>,
): KinCalendarHeld {
  if (AsyncResult.isSuccess(result))
    return { scope, request, outcome: "ready", calendar: result.value };
  return {
    scope,
    request,
    outcome:
      Cause.isCause(result.cause) && kinHostLacksCall(result.cause) ? "unavailable" : "failed",
  };
}

/** `on` is null until this device's choice is known; nothing is asked before it is. */
export function kinCalendarState(input: {
  readonly on: boolean | null;
  readonly held: KinCalendarHeld | null;
  readonly scope: string;
  readonly request: string | null;
}): KinCalendarState {
  const { on, held, scope, request } = input;
  if (on === false) return { _tag: "off" };
  if (held === null || held.scope !== scope) return { _tag: "loading" };
  // A host without the call stays without it while the next window is asked.
  if (held.outcome === "unavailable") return { _tag: "unavailable" };
  if (held.request === request && held.outcome === "failed") return { _tag: "failed" };
  if (held.outcome === "ready")
    return { _tag: "ready", calendar: held.calendar, refreshing: held.request !== request };
  return { _tag: "loading" };
}

/** The switch shows once the host is known to have calendars, and always once it was turned off. */
export const kinCalendarSwitchShown = (state: KinCalendarState) =>
  state._tag === "off" || state._tag === "ready" || state._tag === "failed";

export interface KinCalendarNotice {
  readonly text: string;
  /** Offers Try again (`KIN_RETRY`), which skips the host's short-lived copy. */
  readonly retry: boolean;
  /** Fixed under Your mailboxes, where the phone links. */
  readonly mailboxes: boolean;
  /** Said while it is read: a status, not a problem. */
  readonly status: boolean;
}

const notice = (text: string, more: Partial<KinCalendarNotice> = {}): KinCalendarNotice => ({
  text,
  retry: false,
  mailboxes: false,
  status: false,
  ...more,
});

const mailboxOf = (source: KinCalendarSource) =>
  source.account ??
  (source.company ? `the company's ${MAILBOX[source.service]}` : `your ${MAILBOX[source.service]}`);

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The one line under the toolbar; null when there is nothing to say. */
export function kinCalendarNotice(state: KinCalendarState): KinCalendarNotice | null {
  switch (state._tag) {
    case "off":
    case "unavailable":
      return null;
    case "loading":
      return notice(KIN_CALENDAR.loading, { status: true });
    case "failed":
      return notice(KIN_CALENDAR.loadFailed, { retry: true });
    case "ready":
      break;
  }
  const { sources, more } = state.calendar;
  if (sources.length === 0) return notice(KIN_CALENDAR.notConnected, { mailboxes: true });
  const unreached = sources.filter(
    (source) => source.status === "unreachable" || source.status === "busy",
  );
  const [first] = unreached;
  if (first !== undefined)
    return notice(
      unreached.length > 1
        ? `Couldn't reach ${unreached.length} of your calendars. Your Work dates are all here.`
        : first.account === null
          ? `Couldn't reach ${SERVICE[first.service]}. Your Work dates are all here.`
          : `Couldn't reach ${SERVICE[first.service]} for ${first.account}. Your Work dates are all here.`,
      { retry: true },
    );
  const stuck = sources.find((source) => source.status !== "ok");
  if (stuck !== undefined) {
    const where = stuck.company ? "Settings → Connections" : "Your mailboxes";
    return notice(
      stuck.status === "signed_out"
        ? `Sign in to ${mailboxOf(stuck)} again under ${where}.`
        : `${capitalised(mailboxOf(stuck))} was connected without calendar access. Connect it again under ${where} and allow Calendar.`,
      { mailboxes: !stuck.company },
    );
  }
  return more ? notice(KIN_CALENDAR.more) : null;
}

/** This device's choice, for one person in one company on one Kin. */
export const kinCalendarDeviceKey = (environmentId: string, orgId: string, personId: string) =>
  `${environmentId}:${orgId}:${personId}`;
