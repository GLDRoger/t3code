import { describe, expect, it } from "vite-plus/test";

import { kinSameTimeZone, kinZoneName } from "./kinTimeZone.ts";

describe("kinSameTimeZone", () => {
  it("treats a zone's old and new names as one zone", () => {
    expect(kinSameTimeZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(kinSameTimeZone("Europe/Kyiv", "Europe/Kiev")).toBe(true);
    expect(kinSameTimeZone("Asia/Kolkata", "Asia/Dubai")).toBe(false);
  });
});

describe("kinZoneName", () => {
  it("names a zone by its current spelling, as profiles do", () => {
    expect(kinZoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(kinZoneName("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(kinZoneName("America/New_York")).toBe("America/New_York");
  });
});
