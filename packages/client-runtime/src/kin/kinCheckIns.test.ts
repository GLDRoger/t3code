import { describe, expect, it } from "vite-plus/test";

import { kinBriefLine, kinBriefProblem, kinCheckInDays } from "./kinCheckIns.ts";

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
  });
  it.each([
    [{ at: "07:45", days: [1] }, null],
    [{ at: "7:45", days: [1] }, "Set a time such as 09:30."],
    [{ at: "07:45", days: [] }, "Pick at least one day."],
  ])("%j can be saved: %s", (draft, problem) => {
    expect(kinBriefProblem(draft)).toBe(problem);
  });
});
