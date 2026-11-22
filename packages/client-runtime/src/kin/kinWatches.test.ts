import { describe, expect, it } from "vite-plus/test";

import { KIN_TEXT_LOCALE, type KinWatchLine, type KinWatchLogLook } from "@t3tools/contracts";

import {
  KIN_WATCH_LOG_INTRO,
  KIN_WATCH_LOG_TITLE,
  kinWatchAbout,
  kinWatchLimitLine,
  kinWatchLine,
  kinWatchLogDay,
  kinWatchLogRows,
  kinWatchNoneText,
  kinWatchNothingToday,
} from "./kinWatches.ts";

// Every time below is read in Kolkata (UTC+05:30), whatever zone the test runs in.
const words = { zone: "Asia/Kolkata", locale: KIN_TEXT_LOCALE };
const at = (time: string, day = "2026-11-25") => `${day}T${time}:00+05:30`;
const now = Date.parse(at("14:20"));

const open: KinWatchLine = {
  watchId: "w1",
  kind: "invoice_paid",
  about: "Brightwell Labs' INV-11",
  state: "open",
  lookedAt: at("14:10"),
  nextLookAt: at("14:55"),
  lastOutcome: "nothing_new",
  lastLine: "nothing new",
  looking: false,
  aside: null,
  closedAt: null,
  closedHow: null,
  closedBy: null,
};

describe("the watch line", () => {
  it.each<[string, Partial<KinWatchLine>, number, string | null, ReadonlyArray<string>]>([
    [
      "open, nothing new",
      {},
      now,
      "Kin is watching for the payment · looked 14:10, nothing new · next look about 14:55",
      ["look", "stop"],
    ],
    [
      "looked on another day",
      { lookedAt: at("23:40", "2026-11-23"), nextLookAt: at("09:10", "2026-11-26") },
      now,
      "Kin is watching for the payment · looked Mon 23:40, nothing new · next look about Thu 09:10",
      ["look", "stop"],
    ],
    [
      "never looked yet",
      { lookedAt: null, lastOutcome: null, lastLine: null },
      now,
      "Kin is watching for the payment · next look about 14:55",
      ["look", "stop"],
    ],
    [
      "a code problem",
      { kind: "task_out", lastOutcome: "problem", lastLine: "the work failed" },
      now,
      "Kin is watching this work · 14:10: the work failed · next look about 14:55",
      ["look", "stop"],
    ],
    [
      "can't tell",
      {
        lastOutcome: "cant_tell",
        lastLine: "no mail account that gets bank alerts is connected",
      },
      now,
      "Kin is watching for the payment · can't check yet: no mail account that gets bank alerts is connected",
      ["look", "stop"],
    ],
    [
      "the daily limit",
      { lastOutcome: "skipped_limit" },
      now,
      "Kin is watching for the payment · next look after today's daily limit resets",
      ["look", "stop"],
    ],
    ["looking", { looking: true }, now, "Kin is looking now", ["stop"]],
    [
      "set aside to a day",
      { aside: { until: at("00:00", "2026-12-04") } },
      now,
      "Kin will look again after the hold ends on 4 Dec",
      ["stop"],
    ],
    [
      "set aside until lifted",
      { aside: { until: null } },
      now,
      "Kin will look again after the hold is lifted",
      ["stop"],
    ],
    [
      "closed",
      {
        state: "closed",
        closedAt: at("11:05"),
        closedHow: "INV-11 was paid on 25 Nov",
        closedBy: { kind: "code", name: null, you: false },
      },
      now,
      "Kin stopped watching: INV-11 was paid on 25 Nov",
      ["again"],
    ],
    [
      "stopped by the reader",
      {
        state: "stopped",
        closedAt: at("11:05"),
        closedBy: { kind: "person", name: "Rhea", you: true },
      },
      now,
      "You stopped Kin watching this",
      ["again"],
    ],
    [
      "stopped by someone else",
      {
        state: "stopped",
        closedAt: at("11:05"),
        closedBy: { kind: "person", name: "Arjun", you: false },
      },
      now,
      "Arjun stopped Kin watching this",
      ["again"],
    ],
    [
      "closed more than 3 days ago",
      { state: "closed", closedAt: at("11:05", "2026-11-21"), closedHow: "INV-11 was paid" },
      now,
      null,
      [],
    ],
  ])("%s", (_name, patch, when, text, actions) => {
    const line = kinWatchLine({ ...open, ...patch }, when, words);
    expect(line?.text ?? null).toBe(text);
    expect(line?.actions ?? []).toEqual(actions);
  });

  it.each([
    ["invoice_paid", "", "watching for the payment"],
    ["reply_owed", "Ana", "watching for Ana's reply"],
    ["task_out", "", "watching this work"],
    ["pr", "", "watching for the merge"],
    ["prepare", "the renewal on Tue 2 Dec", "getting ready for the renewal on Tue 2 Dec"],
    [
      "asked",
      "whether Lumen replies about the quote",
      "watching: whether Lumen replies about the quote",
    ],
    ["asked", "x".repeat(130), `watching: ${"x".repeat(120)}`],
  ])("%s about %j reads %j", (kind, about, phrase) => {
    expect(kinWatchAbout({ kind, about })).toBe(phrase);
  });
});

describe("the log", () => {
  const look = (time: string, patch: Partial<KinWatchLogLook> = {}): KinWatchLogLook => ({
    lookId: `l-${time}`,
    at: at(time),
    why: "routine",
    did: "nothing_new",
    outcome: "nothing_new",
    line: "nothing new",
    watchId: "w1",
    kind: "invoice_paid",
    about: "Brightwell Labs' INV-11",
    recordKey: "INV-11",
    ...patch,
  });

  it("reads each row: why it ran, what it did, and a fold of nothing-new looks", () => {
    const rows = [
      {
        _tag: "look" as const,
        look: look("14:10", {
          why: "asked",
          did: "closed",
          outcome: "closed",
          line: "INV-11 was paid on 25 Nov",
        }),
      },
      {
        _tag: "look" as const,
        look: look("13:25", {
          why: "again",
          did: "problem",
          outcome: "problem",
          line: "the work failed",
          kind: "task_out",
          about: "Build the quote page",
        }),
      },
      { _tag: "look" as const, look: look("12:40", { did: "checked_work", kind: "pr" }) },
      {
        _tag: "folded" as const,
        folded: { at: at("11:55"), count: 9, looks: [look("11:55"), look("11:10")] },
      },
    ];
    expect(kinWatchLogRows(rows, words)).toEqual([
      "14:10 · You asked · Closed a loop · Brightwell Labs' INV-11: INV-11 was paid on 25 Nov",
      "13:25 · Worth another look · Spotted a problem · Build the quote page: the work failed",
      "12:40 · Routine round · Checked work · Brightwell Labs' INV-11: nothing new",
      "11:55 · 9 more looks, nothing new",
    ]);
    expect(
      kinWatchLogRows(
        [{ _tag: "folded", folded: { at: at("03:15"), count: 41, looks: [] } }],
        words,
      ),
    ).toEqual(["03:15 · 41 looks, nothing new"]);
  });

  it.each([
    ["2026-11-25", "Today"],
    ["2026-11-24", "Yesterday"],
    ["2026-11-20", "Fri 20 Nov"],
  ])("heads %s as %s", (day, heading) => {
    expect(kinWatchLogDay(day, now, words)).toBe(heading);
  });

  it("says the limit, and each empty state", () => {
    expect([KIN_WATCH_LOG_TITLE, KIN_WATCH_LOG_INTRO]).toEqual([
      "What Kin checked",
      "Kin looks at open loops every 45 minutes, day and night.",
    ]);
    expect(kinWatchLimitLine(Date.parse(at("18:20")), words)).toBe(
      "From 18:20 Kin only did the checks that need no model: today's daily limit was reached.",
    );
    expect(kinWatchNoneText(true)).toBe(
      'Kin isn\'t watching anything yet. Ask any agent to keep an eye on something, such as "keep an eye on whether Lumen pays".',
    );
    expect(kinWatchNoneText(false)).toBe("Kin isn't watching anything of yours.");
    expect(kinWatchNothingToday(at("14:55"), words)).toBe(
      "No checks yet today. The next round is about 14:55.",
    );
  });
});
