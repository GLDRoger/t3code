import { describe, expect, it } from "vite-plus/test";

import type { KinBrief, KinCheckIn } from "@t3tools/contracts";

import {
  kinBriefLine,
  kinBriefProblem,
  kinBriefSave,
  kinBriefTitle,
  kinBriefTurnsOff,
  kinCheckInDays,
  kinCheckInsBeyondBriefs,
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

describe("kinCheckInsBeyondBriefs", () => {
  const checkIn = (scheduleId: string) => ({ scheduleId }) as unknown as KinCheckIn;
  const company = ["checkin-weekly", "checkin-morning", "checkin-evening", "sched-1"].map(checkIn);
  it("drops the check-ins this person already sees as briefs, and only those", () => {
    expect(
      kinCheckInsBeyondBriefs(company, [{ kind: "morning" }, { kind: "evening" }]).map(
        (one) => one.scheduleId,
      ),
    ).toEqual(["checkin-weekly", "sched-1"]);
    expect(kinCheckInsBeyondBriefs(company, [])).toEqual(company);
    // Kin's own page is not the company's morning check-in.
    expect(kinCheckInsBeyondBriefs(company, [{ kind: "morning", page: true }])).toEqual(company);
  });
});
