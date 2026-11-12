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
const decodeStored = Schema.decodeUnknownOption(KinChartCardState);
const many = (count: number) => Array.from({ length: count }, (_, index) => `P${index}`);

const pair = [
  { name: "A", values: [1, 2, 3] },
  { name: "B", values: [1, -2, 3] },
];
const scatter = {
  xName: "Ad spend",
  yName: "Signups",
  xUnit: { kind: "money" as const, currency: "INR" },
  series: [{ name: "Campaigns", points: [{ x: 500000, y: 42, label: "Diwali" }] }],
};
const points = { chart: "scatter" as const, labels: [], series: [], comparison: null, scatter };

describe("kinChartProblem", () => {
  it("accepts a comparison with missing, zero and negative values", () => {
    expect(kinChartProblem(chart)).toBeNull();
    expect(decode(chart)._tag).toBe("Some");
  });

  it.each<[string, Partial<KinChartSpec>]>([
    [
      "a year of days",
      {
        labels: many(365),
        comparison: null,
        series: [{ name: "A", values: many(365).map(() => 1) }],
      },
    ],
    [
      "twelve series",
      { comparison: null, series: many(12).map((name) => ({ name, values: [1, 2, 3] })) },
    ],
    [
      "a stack of one series, and one that dips below zero",
      { chart: "stacked_bar", comparison: null, series: pair },
    ],
    ["labels that repeat", { labels: ["Mon", "Mon", "Wed"] }],
    [
      "a pie with a slice missing, a slice of nothing and its own colours",
      {
        chart: "pie",
        comparison: null,
        colors: ["green", null, "red"],
      },
    ],
    [
      "a radar against its previous period, with a target ring",
      {
        chart: "radar",
        series: [{ name: "Now", values: [3, null, 0] }],
        comparison: { name: "Before", values: [2, 4, 1] },
        target: { name: "Goal", value: 4 },
      },
    ],
    ["a scatter of labelled points", points],
    [
      "one series of bars coloured bar by bar, with its values written",
      {
        chart: "horizontal_bar",
        comparison: null,
        colors: [null, "amber", null],
        valueLabels: true,
      },
    ],
  ])("accepts %s", (_name, change) => {
    const drawn = { ...chart, ...change };
    expect(kinChartProblem(drawn)).toBeNull();
    expect(decode(drawn)._tag).toBe("Some");
  });

  it.each<[string, Partial<KinChartSpec>, string]>([
    ["too many points", { labels: many(501), comparison: null }, "at most 500"],
    [
      "values that don't line up",
      { series: [{ name: "A", values: [1, 2] }] },
      "one value per label",
    ],
    [
      "too many series",
      { comparison: null, series: many(13).map((name) => ({ name, values: [1, 2, 3] })) },
      "at most 12",
    ],
    [
      "more values than a phone should draw",
      {
        comparison: null,
        labels: many(400),
        series: many(8).map((name) => ({ name, values: many(400).map(() => 1) })),
      },
      "labels times series",
    ],
    ["a comparison beside two series", { series: pair }, "exactly one series"],
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
    ["a stack with a comparison", { chart: "stacked_bar" }, 'use chart "bar"'],
    [
      "a negative value in a stacked area",
      { chart: "stacked_area", comparison: null, series: pair },
      'use chart "stacked_bar"',
    ],
    [
      "nothing but gaps",
      { comparison: null, series: [{ name: "A", values: [null, null, null] }] },
      "nothing to draw",
    ],
    ["a title past its limit", { title: "x".repeat(121) }, "120 characters"],
    [
      "a pie with a negative slice",
      { chart: "pie", comparison: null, series: [{ name: "Net", values: [5, -2, 3] }] },
      'use chart "bar"',
    ],
    ["a pie of several series", { chart: "donut", comparison: null, series: pair }, "one series"],
    [
      "a pie of nothing",
      { chart: "pie", comparison: null, series: [{ name: "A", values: [0, null, 0] }] },
      "above zero",
    ],
    [
      "a pie with a target",
      { chart: "pie", comparison: null, target: { name: "Goal", value: 5 } },
      "leave target out",
    ],
    [
      "a radar of two axes",
      {
        chart: "radar",
        labels: ["Mon", "Tue"],
        series: [{ name: "A", values: [1, 2] }],
        comparison: null,
      },
      "three or more axes",
    ],
    ["a radar below zero", { chart: "radar" }, "every axis starts at zero"],
    ["a scatter without points", { ...points, scatter: undefined }, "scatter: {xName"],
    ["a scatter that also sends labels", { ...points, labels: ["Mon"] }, "leave labels"],
    [
      "a scatter point with no y",
      { ...points, scatter: { ...scatter, series: [{ name: "A", points: [{ x: 1, y: null }] }] } },
      "leave that point out",
    ],
    [
      "a scatter with money in decimals on x",
      { ...points, scatter: { ...scatter, series: [{ name: "A", points: [{ x: 1.5, y: 2 }] }] } },
      "minor units",
    ],
    ["points on a chart that isn't a scatter", { scatter }, 'only with chart "scatter"'],
    [
      "more rows than a horizontal chart holds",
      {
        chart: "horizontal_bar",
        comparison: null,
        labels: many(61),
        series: [{ name: "A", values: many(61).map(() => 1) }],
      },
      "at most 60",
    ],
    ["label colours on several series", { colors: [null, null, null] }, "color on each series"],
    ["label colours that don't line up", { comparison: null, colors: ["red"] }, "one per label"],
    ["a target without a name", { target: { name: " ", value: 3 } }, "short name"],
  ])("refuses %s and says how to fix it", (_name, change, fix) => {
    const broken = { ...chart, ...change };
    expect(kinChartProblem(broken)).toContain(fix);
    expect(decode(broken)._tag).toBe("None");
  });

  it("still reads a chart stored before colours, targets and scatters existed", () => {
    const stored = {
      ...chart,
      chart: "stacked_bar",
      comparison: null,
      series: pair.map(({ name }) => ({ name, values: [1, 2, 3] })),
    };
    expect(decodeStored(JSON.parse(JSON.stringify(stored)))._tag).toBe("Some");
  });
});
