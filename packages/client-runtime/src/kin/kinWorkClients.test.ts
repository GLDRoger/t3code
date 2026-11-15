import { describe, expect, it } from "vite-plus/test";

import { kinLastContactLine, kinTouchAt } from "./kinWorkClients.ts";

describe("kinLastContactLine", () => {
  const now = new Date("2026-11-15T10:00:00.000Z");
  it.each([
    [undefined, null],
    [null, "No logged contact yet"],
    ["2026-11-15T08:00:00.000Z", "Last contact today"],
    ["2026-11-13T09:00:00.000Z", "Last contact 2 days ago"],
    ["2026-11-08T10:00:00.000Z", "No logged contact for 7 days"],
    ["2026-09-01T10:00:00.000Z", "No logged contact for 75 days"],
  ] as const)("%s reads %s", (lastAt, line) => {
    expect(kinLastContactLine(lastAt, now)).toBe(line);
  });
});

describe("kinTouchAt", () => {
  it("is now for today and midday for an earlier day, never ahead", () => {
    const now = new Date(2026, 10, 15, 9);
    expect(kinTouchAt("2026-11-15", now)).toBeUndefined();
    expect(kinTouchAt("2026-11-20", now)).toBeUndefined();
    expect(kinTouchAt("2026-11-14", now)).toBe(new Date(2026, 10, 14, 12).toISOString());
  });
});
