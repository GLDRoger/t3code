import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { KinChartCardState, kinChartProblem, type KinChartSpec } from "./kinChart.ts";

const chart: KinChartSpec = {
  chart: "bar",
  title: "Signups",
  caption: null,
  unit: { kind: "count" },
  labelType: "category",
  labels: ["Mon", "Tue", "Wed"],
  series: [{ name: "This week", values: [12, null, 0] }],
  comparison: { name: "Last week", values: [9, 14, -2] },
};
const decode = Schema.decodeOption(KinChartCardState);
const many = (count: number) => Array.from({ length: count }, (_, index) => `P${index}`);

describe("kinChartProblem", () => {
  it("accepts a comparison with missing, zero and negative values", () => {
    expect(kinChartProblem(chart)).toBeNull();
    expect(decode(chart)._tag).toBe("Some");
  });

  it.each<[string, Partial<KinChartSpec>, string]>([
    ["too many points", { labels: many(25), comparison: null }, "at most 24"],
    [
      "values that don't line up",
      { series: [{ name: "A", values: [1, 2] }] },
      "one value per label",
    ],
    ["repeated labels", { labels: ["Mon", "Mon", "Wed"] }, "its own label"],
    [
      "too many series",
      { comparison: null, series: many(5).map((name) => ({ name, values: [1, 2, 3] })) },
      "at most 4",
    ],
    [
      "a comparison beside two series",
      {
        series: [
          { name: "A", values: [1, 2, 3] },
          { name: "B", values: [1, 2, 3] },
        ],
      },
      "exactly one series",
    ],
    [
      "money with decimals",
      {
        unit: { kind: "money", currency: "INR" },
        series: [{ name: "Spend", values: [1299.5, 1, 2] }],
      },
      "minor units",
    ],
    ["a lower-case currency", { unit: { kind: "money", currency: "inr" } }, "ISO 4217"],
    [
      "a date that doesn't exist",
      { labelType: "day", labels: ["2026-02-28", "2026-02-29", "2026-03-01"] },
      "YYYY-MM-DD",
    ],
    [
      "dates out of order",
      { labelType: "month", labels: ["2026-02", "2026-01", "2026-03"] },
      "oldest first",
    ],
    [
      "a stacked bar of one series",
      { chart: "stacked_bar", comparison: null },
      "two or more series",
    ],
    [
      "a negative value in a stack",
      {
        chart: "stacked_bar",
        comparison: null,
        series: [
          { name: "A", values: [1, 2, 3] },
          { name: "B", values: [1, -2, 3] },
        ],
      },
      "negative",
    ],
    [
      "nothing but gaps",
      { comparison: null, series: [{ name: "A", values: [null, null, null] }] },
      "nothing to draw",
    ],
    ["a title past its limit", { title: "x".repeat(81) }, "80 characters"],
  ])("refuses %s and says how to fix it", (_name, change, fix) => {
    const broken = { ...chart, ...change };
    expect(kinChartProblem(broken)).toContain(fix);
    expect(decode(broken)._tag).toBe("None");
  });
});
