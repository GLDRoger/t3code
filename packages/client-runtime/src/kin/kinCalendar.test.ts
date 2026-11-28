// @effect-diagnostics globalDate:off - Fixed instants stand in for the reader's clock.
import {
  KinConnectionId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinCalendarEvent,
  type KinCalendarSource,
  type KinDateRow,
  type KinRecord,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { kinCalendarHeld, kinCalendarNotice, kinCalendarState } from "./kinCalendar.ts";
import { kinDatesAgenda, kinDatesMonth, kinMonthCellLabel } from "./kinDates.ts";
import type { KinWorkNames } from "./kinWork.ts";

const rhea = KinPersonId.make("person-rhea-7f3a");
const own = KinConnectionId.make("conn-google-rhea-01");
const company = KinConnectionId.make("conn-ms-tidewater-02");
const sources: ReadonlyArray<KinCalendarSource> = [
  {
    connectionId: own,
    service: "google",
    account: "rhea@tidewater.example",
    company: false,
    status: "ok",
  },
  {
    connectionId: company,
    service: "microsoft",
    account: "office@tidewater.example",
    company: true,
    status: "ok",
  },
];
const event = (patch: Partial<KinCalendarEvent>): KinCalendarEvent => ({
  connectionId: own,
  id: "evt-1",
  title: "Tidewater Freight review",
  start: "2026-11-27",
  end: "2026-11-28",
  allDay: true,
  zone: null,
  link: null,
  repeats: false,
  ...patch,
});
const where = (zone: string, readerZone?: string): KinWorkNames => ({
  people: new Map(),
  agents: new Map(),
  me: rhea,
  zone,
  ...(readerZone === undefined ? {} : { readerZone }),
});
const now = new Date("2026-11-20T06:00:00.000Z");
const calendarOf = (...events: ReadonlyArray<KinCalendarEvent>) => ({ sources, events });
const eventDays = (cells: ReturnType<typeof kinDatesMonth>["weeks"]) =>
  cells
    .flat()
    .filter((cell) => cell.entries.some((entry) => entry.kind === "event"))
    .map((cell) => cell.day);
const record = (patch: Partial<KinRecord> = {}): KinRecord => ({
  recordId: KinRecordId.make("rec-1"),
  orgId: KinOrgId.make("org-tidewater"),
  key: "W-1",
  title: "Book the Tidewater Freight trucks",
  state: "open",
  waitingOn: null,
  owner: { _tag: "person", personId: rhea },
  category: null,
  side: "ours",
  dueAt: null,
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 1,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T08:00:00.000Z",
  closedAt: null,
  ...patch,
});
const dated = (key: string, at: string, allDay: boolean): KinDateRow => ({
  record: record({ key, dueAt: at, dueAllDay: allDay }),
  listName: "Work",
  stateLabel: "Not started",
  kind: "due",
  label: "Due",
  at,
  allDay,
});

describe("calendar events beside Work dates", () => {
  it("keeps an all-day event on its own date for a reader on either side of the world", () => {
    const trip = event({});
    for (const names of [
      where("Asia/Kolkata"),
      where("America/Los_Angeles"),
      where("America/Los_Angeles", "Asia/Kolkata"),
    ]) {
      const agenda = kinDatesAgenda([], names, now, calendarOf(trip));
      expect(agenda.map((day) => [day.day, day.entries.map((entry) => entry.kind)])).toEqual([
        ["2026-11-27", ["event"]],
      ]);
      expect(eventDays(kinDatesMonth("2026-11", [], names, now, calendarOf(trip)).weeks)).toEqual([
        "2026-11-27",
      ]);
    }
  });

  it("files a timed event on the reader's day and clock", () => {
    const names = where("America/Los_Angeles", "Etc/GMT-14");
    const call = event({
      start: "2026-12-04T10:16:00.000Z",
      end: "2026-12-04T11:00:00.000Z",
      allDay: false,
    });
    const [day] = kinDatesAgenda([], names, now, calendarOf(call));
    const entry = day!.entries[0]!;
    expect([day!.day, entry.kind === "event" ? entry.event.time : null]).toEqual([
      "2026-12-05",
      "12:16 AM",
    ]);
  });

  it("adds the event's own zone only when its clock reads differently, and keeps https links only", () => {
    const standUp = event({
      start: "2026-11-27T15:30:00.000Z",
      end: "2026-11-27T16:00:00.000Z",
      allDay: false,
      zone: "America/New_York",
      repeats: true,
      link: "https://calendar.google.com/calendar/event?eid=abc123",
    });
    const line = (names: KinWorkNames, one: KinCalendarEvent) => {
      const entry = kinDatesAgenda([], names, now, calendarOf(one))[0]!.entries[0]!;
      return entry.kind === "event" ? entry.event : null;
    };
    expect(line(where("Asia/Kolkata"), standUp)).toMatchObject({
      line: "9:00 PM · 10:30 AM New York · rhea@tidewater.example · Repeats",
      link: "https://calendar.google.com/calendar/event?eid=abc123",
    });
    expect(line(where("America/Toronto"), standUp)?.line).toBe(
      "10:30 AM · rhea@tidewater.example · Repeats",
    );
    expect(line(where("Asia/Kolkata"), { ...standUp, zone: "Asia/Calcutta" })?.line).toBe(
      "9:00 PM · rhea@tidewater.example · Repeats",
    );
    expect(
      line(where("Asia/Kolkata"), { ...standUp, link: "javascript:alert(1)" })?.link,
    ).toBeNull();
    expect(
      line(where("Asia/Kolkata"), { ...standUp, connectionId: company, title: null }),
    ).toMatchObject({
      title: "(No title)",
    });
    expect(line(where("Asia/Kolkata"), standUp)?.accessibilityLabel).toMatch(
      /Opens in Google Calendar$/,
    );
  });

  it("shows a multi-day all-day event on each day it covers, and once in the agenda", () => {
    const names = where("UTC");
    const trip = event({ start: "2026-11-28", end: "2026-12-01" });
    expect(eventDays(kinDatesMonth("2026-11", [], names, now, calendarOf(trip)).weeks)).toEqual([
      "2026-11-28",
      "2026-11-29",
      "2026-11-30",
    ]);
    // December's grid opens on Monday 30 November; the end day, 1 December, isn't covered.
    expect(eventDays(kinDatesMonth("2026-12", [], names, now, calendarOf(trip)).weeks)).toEqual([
      "2026-11-30",
    ]);
    const agenda = kinDatesAgenda([], names, now, calendarOf(trip));
    expect(agenda.map((day) => day.day)).toEqual(["2026-11-28"]);
    const entry = agenda[0]!.entries[0]!;
    expect(entry.kind === "event" ? entry.event.line : null).toBe(
      "until Mon, Nov 30 · rhea@tidewater.example",
    );
    // One that began before the agenda looks back shows on the agenda's first day.
    const long = event({ start: "2026-09-01", end: "2026-12-01" });
    expect(kinDatesAgenda([], names, now, calendarOf(long)).map((day) => day.day)).toEqual([
      "2026-10-21",
    ]);
  });

  it("puts all-day items first, Work then events, then timed ones by time", () => {
    const names = where("UTC");
    const rows = [
      dated("W-9", "2026-11-27T09:00:00.000Z", false),
      dated("W-1", "2026-11-27T00:00:00.000Z", true),
    ];
    const events = calendarOf(
      event({ id: "evt-ten", start: "2026-11-27T10:00:00.000Z", end: null, allDay: false }),
      event({ id: "evt-eight", start: "2026-11-27T08:00:00.000Z", end: null, allDay: false }),
      event({ id: "evt-day" }),
    );
    const order = (entries: ReadonlyArray<{ readonly id: string }>) => entries.map((one) => one.id);
    expect(order(kinDatesAgenda(rows, names, now, events)[0]!.entries)).toEqual([
      "W-1:due",
      `${own}:evt-day`,
      `${own}:evt-eight`,
      "W-9:due",
      `${own}:evt-ten`,
    ]);
    const cell = kinDatesMonth("2026-11", rows, names, now, events)
      .weeks.flat()
      .find((one) => one.day === "2026-11-27")!;
    expect([order(cell.entries).length, cell.rows.length]).toEqual([5, 2]);
  });

  // A screen reader hears a day as words, the grid's own calendar day whatever the device's zone.
  it.each([
    ["2026-11-27", "Friday, November 27, 5 entries"],
    ["2026-11-20", "Friday, November 20, Today"],
    ["2026-11-30", "Monday, November 30"],
    ["2026-12-01", "Tuesday, December 1"],
  ])("names %s in words", (day, label) => {
    const rows = [
      dated("W-9", "2026-11-27T09:00:00.000Z", false),
      dated("W-1", "2026-11-27T00:00:00.000Z", true),
    ];
    const events = calendarOf(
      event({ id: "evt-ten", start: "2026-11-27T10:00:00.000Z", end: null, allDay: false }),
      event({ id: "evt-eight", start: "2026-11-27T08:00:00.000Z", end: null, allDay: false }),
      event({ id: "evt-day" }),
    );
    const cell = kinDatesMonth("2026-11", rows, where("Pacific/Kiritimati", "UTC"), now, events)
      .weeks.flat()
      .find((one) => one.day === day)!;
    expect(kinMonthCellLabel(cell)).toBe(label);
  });

  const [google, outlook] = sources;
  const busy = (source: KinCalendarSource, account = source.account): KinCalendarSource => ({
    ...source,
    account,
    status: "busy",
  });
  it.each([
    {
      failing: [busy(google!)],
      text: "Google Calendar is busy for rhea@tidewater.example. Try again in a minute. Your Work dates are all here.",
    },
    {
      failing: [busy(outlook!)],
      text: "Outlook is busy for office@tidewater.example. Try again in a minute. Your Work dates are all here.",
    },
    {
      failing: [busy(google!, null)],
      text: "Google Calendar is busy. Try again in a minute. Your Work dates are all here.",
    },
    {
      failing: [busy(outlook!, null)],
      text: "Outlook is busy. Try again in a minute. Your Work dates are all here.",
    },
    {
      failing: [busy(google!), { ...outlook!, status: "unreachable" as const }],
      text: "Couldn't reach 2 of your calendars. Your Work dates are all here.",
    },
    {
      failing: [busy(google!), busy(outlook!)],
      text: "2 of your calendars are busy. Try again in a minute. Your Work dates are all here.",
    },
  ])("keeps the event cap alongside $text", ({ failing, text }) => {
    expect(
      kinCalendarNotice({
        _tag: "ready",
        calendar: { sources: failing, events: [], more: true },
        refreshing: false,
      }),
    ).toMatchObject({
      retry: true,
      text: `${text} Some events don't fit here. Your calendar has them all.`,
    });
  });

  it("treats a host without the calendar as unavailable, not as a failure", () => {
    const scope = "env-1:org-tidewater";
    const request = `${scope}:2026-11-01:2026-12-01:0`;
    const state = (result: Parameters<typeof kinCalendarHeld>[2], on: boolean | null = true) =>
      kinCalendarState({ on, held: kinCalendarHeld(scope, request, result), scope, request })._tag;
    expect(
      state(AsyncResult.failure(Cause.die("Unknown request tag: kin.connections.mineCalendar"))),
    ).toBe("unavailable");
    expect(state(AsyncResult.failure(Cause.die(new Error("socket closed"))))).toBe("failed");
    expect(state(AsyncResult.success({ sources, events: [], more: false }), false)).toBe("off");
    // Two calendars out of reach say so once, with Try again.
    const unreached = kinCalendarNotice({
      _tag: "ready",
      calendar: {
        sources: sources.map((one) => ({ ...one, status: "unreachable" as const })),
        events: [],
        more: false,
      },
      refreshing: false,
    });
    expect(unreached).toMatchObject({
      retry: true,
      text: expect.stringMatching(/^Couldn't reach 2 /),
    });
    // An address keeps its own case; only the "your … mailbox" stand-in starts a sentence.
    const ungranted = (account: string | null) =>
      kinCalendarNotice({
        _tag: "ready",
        calendar: {
          sources: [{ ...sources[0]!, account, status: "no_calendar_permission" }],
          events: [],
          more: false,
        },
        refreshing: false,
      })?.text;
    expect([ungranted("rhea@tidewater.example"), ungranted(null)]).toEqual([
      "rhea@tidewater.example was connected without calendar access. Connect it again under Your mailboxes and allow Calendar.",
      "Your Google mailbox was connected without calendar access. Connect it again under Your mailboxes and allow Calendar.",
    ]);
  });

  it.each([
    {
      label: "web, company signed out",
      calendarSources: [{ ...outlook!, status: "signed_out" as const }],
      connectionsInSettings: undefined,
      mailboxes: false,
      text: "Sign in to office@tidewater.example again under Settings → Connections.",
    },
    {
      label: "phone, company signed out",
      calendarSources: [{ ...outlook!, status: "signed_out" as const }],
      connectionsInSettings: false,
      mailboxes: false,
      text: "Sign in to office@tidewater.example again in Kin on your computer, under Settings → Connections.",
    },
    {
      label: "web, company without calendar access",
      calendarSources: [{ ...outlook!, status: "no_calendar_permission" as const }],
      connectionsInSettings: true,
      mailboxes: false,
      text: "office@tidewater.example was connected without calendar access. Connect it again under Settings → Connections and allow Calendar.",
    },
    {
      label: "phone, company without calendar access",
      calendarSources: [{ ...outlook!, status: "no_calendar_permission" as const }],
      connectionsInSettings: false,
      mailboxes: false,
      text: "office@tidewater.example was connected without calendar access. Connect it again in Kin on your computer, under Settings → Connections and allow Calendar.",
    },
    {
      label: "phone, own signed out stays under Your mailboxes",
      calendarSources: [{ ...google!, status: "signed_out" as const }],
      connectionsInSettings: false,
      mailboxes: true,
      text: "Sign in to rhea@tidewater.example again under Your mailboxes.",
    },
    {
      label: "web, no calendar connected",
      calendarSources: [],
      connectionsInSettings: undefined,
      mailboxes: true,
      text: "Connect your calendar under Settings → Connections → Your mailboxes to see its events here.",
    },
    {
      label: "phone, no calendar connected",
      calendarSources: [],
      connectionsInSettings: false,
      mailboxes: true,
      text: "Connect your calendar under Settings → Your mailboxes to see its events here.",
    },
  ])(
    "names the real Settings path for each surface ($label)",
    ({ calendarSources, connectionsInSettings, mailboxes, text }) => {
      expect(
        kinCalendarNotice(
          {
            _tag: "ready",
            calendar: { sources: calendarSources, events: [], more: false },
            refreshing: false,
          },
          connectionsInSettings === undefined ? undefined : { connectionsInSettings },
        ),
      ).toMatchObject({ mailboxes, text });
    },
  );
});
