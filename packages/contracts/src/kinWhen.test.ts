import { describe, expect, it } from "vite-plus/test";

import { formatKinWhen, KIN_TEXT_LOCALE, kinWhenParts } from "./kinWhen.ts";

// The same hour read "3:00 pm" in budget lines and "15:00" in prompts and away notes.
const AT = Date.UTC(2026, 10, 17, 9, 30);
const ZONE = "Asia/Kolkata";

describe("one way to write a day and a time", () => {
  it.each([
    ["en-GB", "15:00", "Tue 17 Nov", "Tue 17 Nov, 15:00"],
    ["en-US", "3:00 PM", "Tue, Nov 17", "Tue, Nov 17, 3:00 PM"],
    ["en-IN", "3:00 pm", "Tue, 17 Nov", "Tue, 17 Nov, 3:00 pm"],
  ])("%s keeps its own clock: %s", (locale, time, day, dayTime) => {
    expect(formatKinWhen(AT, "time", { zone: ZONE, locale })).toBe(time);
    expect(formatKinWhen(AT, "day", { zone: ZONE, locale })).toBe(day);
    expect(formatKinWhen(AT, "dayTime", { zone: ZONE, locale })).toBe(dayTime);
  });

  it("writes server text in one locale, two-digit 24-hour", () => {
    expect(
      formatKinWhen(Date.UTC(2026, 10, 17, 3, 35), "time", { zone: ZONE, locale: KIN_TEXT_LOCALE }),
    ).toBe("09:05");
  });

  it("reads an instant's calendar fields in a zone", () => {
    expect(kinWhenParts(AT, ZONE)).toEqual({
      year: 2026,
      month: 11,
      day: 17,
      hour: 15,
      minute: 0,
      second: 0,
      weekday: "Tue",
      isoDay: "2026-11-17",
    });
  });
});
