import { describe, expect, it } from "vite-plus/test";

import { kinSettingDiffers, kinSettingSetAll, kinSettingSpread } from "./kinSettingsSpread.ts";

describe("kinSettingSpread", () => {
  it.each([
    ["nothing", [], { kind: "none" }],
    ["all on", ["ask", "ask", "ask"], { kind: "same", value: "ask" }],
    ["all off", ["off", "off"], { kind: "same", value: "off" }],
    ["mixed, most off", ["ask", "off", "off"], { kind: "mixed", common: "off" }],
    ["mixed tie, the first thing's", ["ask", "off"], { kind: "mixed", common: "ask" }],
  ])("%s", (_name, values, spread) => {
    expect(kinSettingSpread<string>(values)).toEqual(spread);
  });

  it("compares with the given equality", () => {
    const spread = kinSettingSpread(
      [
        [1, 2],
        [1, 2],
      ],
      (a, b) => a.join() === b.join(),
    );
    expect(spread.kind).toBe("same");
  });
});

describe("kinSettingDiffers", () => {
  it("names only the thing that differs from the rest", () => {
    const spread = kinSettingSpread(["ask", "ask", "off"]);
    expect(kinSettingDiffers("off", spread)).toBe(true);
    expect(kinSettingDiffers("ask", spread)).toBe(false);
    expect(kinSettingDiffers("off", kinSettingSpread(["off", "off"]))).toBe(false);
  });
});

describe("kinSettingSetAll", () => {
  it("writes only the things that don't have the value yet", () => {
    const items = [
      { id: "a", mode: "off" },
      { id: "b", mode: "ask" },
      { id: "c", mode: "off" },
    ];
    expect(kinSettingSetAll(items, (item) => item.mode, "ask").map((item) => item.id)).toEqual([
      "a",
      "c",
    ]);
    expect(kinSettingSetAll([{ mode: "ask" }], (item) => item.mode, "ask")).toEqual([]);
  });
});
