import { describe, expect, it } from "vite-plus/test";

import type { KinBrief, KinCheckIn } from "@t3tools/contracts";

import {
  kinBriefLine,
  kinBriefProblem,
  kinBriefSave,
  kinBriefTitle,
  kinBriefTurnsOff,
  kinCheckInDays,
  kinBriefSheetFields,
  kinClockChoices,
  kinWeeklyBrief,
} from "./kinCheckIns.ts";

describe("kinCheckInDays", () => {
  it.each([
    [[1, 2, 3, 4, 5], "Weekdays"],
    [[0, 1, 2, 3, 4, 5, 6], "Every day"],
    [[6, 0], "Weekends"],
    [[1], "Mondays"],
    [[0, 3, 1], "Mon, Wed, Sun"],
  ])("%j reads %s", (days, label) => {
    expect(kinCheckInDays(days)).toBe(label);
  });
});

describe("a brief", () => {
  const morning = {
    kind: "morning",
    at: "09:30",
    days: [0, 1, 2, 3, 4, 5, 6],
    around: true,
    on: true,
  } as const;
  it("reads its time and days, and says when it is off", () => {
    expect(kinBriefLine(morning)).toBe("Around 09:30 · Every day");
    expect(
      kinBriefLine({ ...morning, kind: "evening", at: "18:30", days: [1, 2, 3, 4, 5], on: false }),
    ).toBe("Off · Around 18:30 · Weekdays");
    const page = { ...morning, at: "08:00", days: [1, 2, 3, 4, 5], around: false, page: true };
    expect(kinBriefLine({ ...page, on: false })).toBe("Off · 08:00 · Weekdays");
    expect([kinBriefTitle(morning), kinBriefTitle(page)]).toEqual([
      "Morning brief",
      "Morning page",
    ]);
    // The owner's morning brief always comes; a teammate's own page can be off.
    const kinds: ReadonlyArray<Pick<KinBrief, "kind" | "page">> = [
      morning,
      { kind: "evening" },
      page,
    ];
    expect(kinds.map((one) => kinBriefTurnsOff(one))).toEqual([false, true, true]);
  });
  it.each([
    [{ at: "07:45", days: [1] }, null],
    [{ at: "7:45", days: [1] }, "Set a time such as 09:30."],
    [{ at: "07:45", days: [] }, "Pick at least one day."],
  ])("%j can be saved: %s", (draft, problem) => {
    expect(kinBriefProblem(draft)).toBe(problem);
  });
  it.each([
    [{ at: "07:45" }, ["at"]],
    // The phone adds a day at the end: the same days in another order are no change.
    [{ days: [1, 2, 3, 4, 5, 6, 0] }, []],
    [{ days: [1, 2] }, ["days"]],
    [{ on: false }, ["on"]],
  ])("a save of %j names only %j as changed", (change, changed) => {
    expect(kinBriefSave(morning, { ...morning, ...change }).changed).toEqual(changed);
  });
});

describe("the phone's brief sheet", () => {
  const checkIn = (scheduleId: string, numbers?: KinCheckIn["numbers"]) =>
    ({ scheduleId, ...(numbers === undefined ? {} : { numbers }) }) as unknown as KinCheckIn;
  it("lists the weekly brief with the briefs, and leaves every other check-in to its agent", () => {
    const company = ["checkin-morning", "sched-1", "checkin-weekly"].map((id) => checkIn(id));
    expect(kinWeeklyBrief(company)?.scheduleId).toBe("checkin-weekly");
    expect(kinWeeklyBrief(company.slice(0, 2))).toBeNull();
  });
  it("holds on or off, the time and the days; never a name, what it's for or Remove", () => {
    expect(kinBriefSheetFields({ brief: { kind: "morning" } })).toEqual(["time", "days"]);
    expect(kinBriefSheetFields({ brief: { kind: "morning", page: true } })).toEqual([
      "on",
      "time",
      "days",
    ]);
    expect(kinBriefSheetFields({ brief: { kind: "evening" } })).toEqual(["on", "time"]);
    expect(kinBriefSheetFields({ checkIn: checkIn("checkin-weekly", ["pipeline"]) })).toEqual([
      "on",
      "time",
      "days",
      "pipeline",
      "runNow",
    ]);
    expect(kinBriefSheetFields({ checkIn: checkIn("sched-1") })).toEqual([
      "on",
      "time",
      "days",
      "runNow",
    ]);
  });
  it("offers each half hour, keeping a time set between them", () => {
    const grid = kinClockChoices("09:30");
    expect([grid.length, grid[0], grid.at(-1)]).toEqual([48, "00:00", "23:30"]);
    const kept = kinClockChoices("07:45");
    expect(kept.length).toBe(49);
    expect(kept.slice(15, 18)).toEqual(["07:30", "07:45", "08:00"]);
  });
});
