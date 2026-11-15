import { describe, expect, it } from "vitest";

import { kinCheckInDays } from "./kinCheckIns.ts";

describe("kinCheckInDays", () => {
  it.each([
    [[1, 2, 3, 4, 5], "Weekdays"],
    [[0, 1, 2, 3, 4, 5, 6], "Every day"],
    [[6, 0], "Weekends"],
    [[1], "Mons"],
    [[0, 3, 1], "Mon, Wed, Sun"],
  ])("%j reads %s", (days, label) => {
    expect(kinCheckInDays(days)).toBe(label);
  });
});
