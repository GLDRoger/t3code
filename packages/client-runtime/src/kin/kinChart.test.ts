import type { KinChartSpec, KinChartUnit } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatKinChartValue, kinChartLayout, kinChartView } from "./kinChart.ts";

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
const size = { width: 320, height: 150 };

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
    expect(view.table.columns).toEqual(["This week", "Last week"]);
    expect(view.table.rows.map((row) => [row.label, ...row.cells])).toEqual([
      ["Mon", "12", "9"],
      ["Tue", "–", "14"],
      ["Wed", "0", "−2"],
    ]);
    expect(view.series.map((series) => series.tone)).toEqual(["previous", "one"]);
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
});

describe("kinChartLayout", () => {
  it("stands bars on zero, marks a zero and leaves a gap for a missing value", () => {
    const layout = kinChartLayout(kinChartView(spec()), size);
    expect(layout.bars.map((bar) => bar.key)).toEqual(["series-0-0", "series-0-2"]);
    const [tall, zero] = layout.bars;
    expect(tall!.y + tall!.height).toBeCloseTo(layout.plot.bottom, 0);
    expect(zero!.height).toBe(1.5);
    expect(layout.yTicks[0]).toMatchObject({ value: 0, label: "0" });
    expect(layout.zeroY).toBeNull();
  });

  it("hangs negative bars below a zero line inside the plot", () => {
    const layout = kinChartLayout(
      kinChartView(spec({ series: [{ name: "Net", values: [40, -20, 10] }] })),
      size,
    );
    const zeroY = layout.zeroY!;
    expect(zeroY).toBeGreaterThan(layout.plot.top);
    expect(zeroY).toBeLessThan(layout.plot.bottom);
    const [up, down] = layout.bars;
    expect(up!.y + up!.height).toBeCloseTo(zeroY, 0);
    expect(down!.y).toBeCloseTo(zeroY, 0);
  });

  it("stacks series to their total", () => {
    const layout = kinChartLayout(
      kinChartView(
        spec({
          chart: "stacked_bar",
          labels: ["Q1"],
          series: [
            { name: "Web", values: [30] },
            { name: "App", values: [70] },
          ],
        }),
      ),
      size,
    );
    const [web, app] = layout.bars;
    expect(layout.yTicks.at(-1)!.value).toBe(100);
    expect(app!.y).toBeCloseTo(layout.plot.top, 0);
    expect(app!.y + app!.height).toBeCloseTo(web!.y, 0);
    expect(web!.x).toBe(app!.x);
  });

  it("breaks a line at a missing value and dots a point left on its own", () => {
    const labels = Array.from(
      { length: 14 },
      (_, index) => `2026-11-${String(index + 1).padStart(2, "0")}`,
    );
    const values = labels.map((_, index) => (index === 3 || index === 5 ? null : 100 + index));
    const layout = kinChartLayout(
      kinChartView(
        spec({ chart: "line", labelType: "day", labels, series: [{ name: "Visits", values }] }),
      ),
      size,
    );
    const [line] = layout.lines;
    expect(line!.path.match(/M/g)).toHaveLength(3);
    expect(line!.dots.map((dot) => dot.key)).toEqual(["series-0-4"]);
    // A narrow band zooms in instead of flattening against zero.
    expect(layout.yTicks[0]!.value).toBeGreaterThan(0);
    // Dates thin out from the latest, and no two labels share room.
    expect(layout.xTicks.at(-1)!.label).toBe("14 Nov");
    expect(layout.xTicks.length).toBeLessThan(labels.length);
  });

  it("draws one point, and a chart of zeros, without dividing by nothing", () => {
    const one = kinChartLayout(
      kinChartView(
        spec({ chart: "line", labels: ["Today"], series: [{ name: "Open", values: [7] }] }),
      ),
      size,
    );
    expect(one.lines[0]!.dots).toHaveLength(1);
    expect(one.lines[0]!.dots[0]!.x).toBeGreaterThan(one.plot.left);
    const zeros = kinChartLayout(
      kinChartView(spec({ series: [{ name: "Errors", values: [0, 0, 0] }] })),
      size,
    );
    expect(zeros.yTicks).toHaveLength(1);
    expect(zeros.bars.every((bar) => Number.isFinite(bar.y) && bar.height === 1.5)).toBe(true);
  });

  it("shortens long labels and keeps them inside the card at phone width", () => {
    const labels = [
      "Enterprise annual contracts",
      "Self-serve monthly",
      "Partner referrals",
      "Other",
    ];
    const layout = kinChartLayout(
      kinChartView(spec({ labels, series: [{ name: "Deals", values: [4, 9, 2, 1] }] })),
      { width: 260, height: 132 },
    );
    expect(layout.xTicks[0]!.label).toBe("Enterpris…");
    for (const tick of layout.xTicks) {
      const half = (tick.label.length * 6) / 2;
      const [from, to] =
        tick.anchor === "middle"
          ? [tick.x - half, tick.x + half]
          : tick.anchor === "start"
            ? [tick.x, tick.x + half * 2]
            : [tick.x - half * 2, tick.x];
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThanOrEqual(260);
    }
  });
});
