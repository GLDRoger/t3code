import { describe, expect, it } from "vite-plus/test";

import { kinSameTimeZone, kinZoneLabel, kinZoneName } from "./kinTimeZone.ts";

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

describe("kinZoneLabel", () => {
  const january = Date.UTC(2026, 0, 15);
  it.each([
    ["Asia/Kolkata", "India Standard Time"],
    ["Asia/Calcutta", "India Standard Time"],
    ["America/Los_Angeles", "Pacific Time"],
    ["Pacific/Auckland", "New Zealand Time"],
    ["UTC", "UTC"],
    ["Etc/UTC", "UTC"],
    ["Etc/GMT-13", "GMT+13"],
    ["Etc/GMT+5", "GMT-5"],
  ])("names %s as %s, never by its id", (zone, label) => {
    expect(kinZoneLabel(zone, "en", january)).toBe(label);
  });
  it("names a zone the platform doesn't know by its place", () => {
    expect(kinZoneLabel("Not/Real_Place", "en", january)).toBe("Real Place");
  });
});
