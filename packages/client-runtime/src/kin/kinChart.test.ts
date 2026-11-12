import type { KinChartSpec, KinChartUnit } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatKinChartValue, kinChartView } from "./kinChart.ts";

const inr: KinChartUnit = { kind: "money", currency: "INR" };
const spec = (change: Partial<KinChartSpec> = {}): KinChartSpec => ({
  chart: "bar",
  title: "Signups",
  caption: null,
  unit: { kind: "count" },
  labelType: "category",
  labels: ["Mon", "Tue", "Wed"],
  series: [{ name: "This week", values: [12, null, 0] }],
  comparison: null,
  ...change,
});

describe("formatKinChartValue", () => {
  it.each<[KinChartUnit, number, "full" | "compact", string]>([
    [inr, 12345678950, "full", "₹12,34,56,789.50"],
    [inr, 129900, "full", "₹1,299"],
    [inr, -5, "full", "−₹0.05"],
    [inr, 12500000, "compact", "₹1.25L"],
    [inr, 3500000000, "compact", "₹3.5Cr"],
    [inr, 150000, "compact", "₹1.5K"],
    [{ kind: "money", currency: "USD" }, 123456789, "full", "$1,234,567.89"],
    [{ kind: "money", currency: "USD" }, 250000000, "compact", "$2.5M"],
    [{ kind: "money", currency: "JPY" }, 1234567, "full", "¥1,234,567"],
    [{ kind: "money", currency: "KWD" }, 1234567, "full", "KWD 1,234.567"],
    // The largest value a chart takes still splits exactly.
    [inr, 999999999999999, "full", "₹99,99,99,99,99,999.99"],
    [{ kind: "count" }, 1234567.5, "full", "1,234,567.5"],
    [{ kind: "count" }, 15300, "compact", "15.3K"],
    [{ kind: "percent" }, -12.5, "full", "−12.5%"],
  ])("%o %d (%s) reads %s", (unit, value, style, text) => {
    expect(formatKinChartValue(unit, value, style)).toBe(text);
  });
});

describe("kinChartView", () => {
  it("says the chart in words and as a table, the current period first", () => {
    const view = kinChartView(
      spec({
        caption: "Acme, all plans",
        comparison: { name: "Last week", values: [9, 14, -2] },
      }),
    );
    expect(view.summary).toBe(
      "Bar chart: Signups. This week: 12 (Mon) to 0 (Wed); highest 12 (Mon), lowest 0 (Wed). Last week: 9 (Mon) to −2 (Wed); highest 14 (Tue), lowest −2 (Wed). 1 value is missing. Acme, all plans.",
    );
    expect(view.table.columns.map((column) => column.name)).toEqual(["This week", "Last week"]);
    expect(view.table.rows.map((row) => [row.label, ...row.cells])).toEqual([
      ["Mon", "12", "9"],
      ["Tue", "–", "14"],
      ["Wed", "0", "−2"],
    ]);
    expect(view.series.map((series) => [series.previous, series.tone.color])).toEqual([
      [true, "grey"],
      [false, "accent"],
    ]);
    expect(view.legend.map((item) => item.mark)).toEqual(["box", "box"]);
    expect(view.legend.map((item) => item.name)).toEqual(["This week", "Last week"]);
  });

  it("keeps a money column's minor digits once any value has them, and reads dates", () => {
    const view = kinChartView(
      spec({
        chart: "line",
        unit: inr,
        labelType: "month",
        labels: ["2026-11", "2026-12", "2027-01"],
        series: [{ name: "Spend", values: [12000000, 12345650, 900000] }],
      }),
    );
    expect(view.table.rows.map((row) => [row.label, ...row.cells])).toEqual([
      ["Nov 2026", "₹1,20,000.00"],
      ["Dec 2026", "₹1,23,456.50"],
      ["Jan 2027", "₹9,000.00"],
    ]);
    expect(view.labels.map((label) => label.short)).toEqual(["Nov", "Dec", "Jan ’27"]);
    expect(view.legend).toEqual([]);
  });

  it("reads a pie as shares of its total, and draws the smallest of many slices as one", () => {
    const view = kinChartView(
      spec({
        chart: "donut",
        unit: inr,
        labels: ["Rent", "Salaries", "Cloud", "Travel"],
        series: [{ name: "Spend", values: [5000000, 15000000, null, 0] }],
        colors: [null, "accent", null, null],
      }),
    );
    expect(view.table.columns.map((column) => column.name)).toEqual(["Spend", "Share"]);
    expect(view.table.rows.map((row) => [row.label, ...row.cells])).toEqual([
      ["Rent", "₹50,000", "25%"],
      ["Salaries", "₹1,50,000", "75%"],
      ["Cloud", "–", "–"],
      ["Travel", "₹0", "0%"],
      ["Total", "₹2,00,000", "100%"],
    ]);
    expect(view.total).toBe("₹2L");
    expect(view.legend.map((item) => [item.name, item.tone.color, item.detail])).toEqual([
      // A slice left to the default never takes the colour another slice asked for.
      ["Rent", "amber", "₹50,000 · 25%"],
      ["Salaries", "accent", "₹1,50,000 · 75%"],
      ["Travel", "green", "₹0 · 0%"],
    ]);
    expect(view.summary).toBe(
      "Donut chart: Signups. Total ₹2,00,000. Rent: ₹50,000, 25%. Salaries: ₹1,50,000, 75%. Travel: ₹0, 0%. 1 value is missing.",
    );

    const labels = Array.from({ length: 20 }, (_, index) => `Team ${index + 1}`);
    const many = kinChartView(
      spec({
        chart: "pie",
        labels,
        series: [
          { name: "Tickets", values: labels.map((_, index) => (index === 19 ? 1000 : index + 1)) },
        ],
      }),
    );
    expect(many.slices).toHaveLength(12);
    expect(many.slices.at(-2)!.name).toBe("Team 20");
    expect(many.slices.at(-1)).toMatchObject({ name: "9 others", value: 45 });
    expect(many.table.rows).toHaveLength(21);
  });

  it("reads a scatter as its two measures, each in its own unit", () => {
    const view = kinChartView(
      spec({
        chart: "scatter",
        labels: [],
        series: [],
        target: { name: "Goal", value: 50 },
        scatter: {
          xName: "Ad spend",
          yName: "Signups",
          xUnit: inr,
          series: [
            {
              name: "Search",
              points: [
                { x: 12000000, y: 40, label: "Diwali" },
                { x: 3000050, y: 12 },
              ],
            },
            { name: "Social", color: "purple", points: [{ x: 500000, y: 3 }] },
          ],
        },
      }),
    );
    expect(view.table.columns.map((column) => column.name)).toEqual([
      "Group",
      "Ad spend",
      "Signups",
    ]);
    expect(view.table.rows.map((row) => [row.label, ...row.cells])).toEqual([
      ["Diwali", "Search", "₹1,20,000.00", "40"],
      ["Search 2", "Search", "₹30,000.50", "12"],
      ["Social 1", "Social", "₹5,000.00", "3"],
    ]);
    expect(view.legend.map((item) => [item.name, item.tone.color, item.mark])).toEqual([
      ["Search", "accent", "dot"],
      ["Social", "purple", "dot"],
      ["Goal 50", "grey", "dashed"],
    ]);
    expect(view.summary).toBe(
      "Scatter chart: Signups. Signups against Ad spend. Search: 2 points, Ad spend ₹30,000.50 to ₹1,20,000.00, Signups 12 to 40. Social: 1 point, Ad spend ₹5,000.00, Signups 3. Goal: 50.",
    );
  });

  it("says a radar by its strongest and weakest axis, and gives twelve series twelve tones", () => {
    const view = kinChartView(
      spec({
        chart: "radar",
        labels: ["Speed", "Cost", "Quality"],
        series: Array.from({ length: 12 }, (_, index) => ({
          name: `Vendor ${index + 1}`,
          values: [index, 5, 9],
        })),
      }),
    );
    expect(view.summary).toContain("Vendor 1: highest 9 (Quality), lowest 0 (Speed).");
    expect(new Set(view.series.map((one) => `${one.tone.color}${one.tone.soft}`)).size).toBe(12);
    expect(view.legend[0]!.mark).toBe("line");
  });
});
