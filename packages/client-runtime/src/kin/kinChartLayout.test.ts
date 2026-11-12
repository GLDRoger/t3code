// @effect-diagnostics globalDate:off - Fixtures build ISO dates from a fixed day.
import type { KinChartSpec } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinChartView } from "./kinChart.ts";
import { kinChartLayout, type KinChartLayout, type KinChartSize } from "./kinChartLayout.ts";

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
const phone = { width: 320 };
const draw = (change: Partial<KinChartSpec>, size: KinChartSize = phone) =>
  kinChartLayout(kinChartView(spec(change)), size);
const keyed = <T extends { readonly key: string }>(items: ReadonlyArray<T>, prefix: string) =>
  items.filter((item) => item.key.startsWith(prefix));
const days = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1 + index));
    return date.toISOString().slice(0, 10);
  });
/** The y of a horizontal rule, from its path. */
const ruleY = (layout: KinChartLayout, key: string) =>
  Number(/^M\S+ (\S+)L/.exec(layout.rules.find((rule) => rule.key === key)!.path)![1]);
const plotBottom = (layout: KinChartLayout) => layout.height - 20;

describe("kinChartLayout", () => {
  it("stands bars on zero, marks a zero and leaves a gap for a missing value", () => {
    const layout = draw({});
    expect(layout.bars.map((bar) => bar.key)).toEqual(["series-0-0", "series-0-2"]);
    const [tall, zero] = layout.bars;
    expect(tall!.y + tall!.height).toBeCloseTo(plotBottom(layout), 0);
    expect(zero!.height).toBe(1.5);
    expect(layout.axis.texts[0]).toMatchObject({ key: "y-0", text: "0" });
    expect(layout.rules.some((rule) => rule.strong)).toBe(false);
    // The axis and the plot together fill the room, with nothing to scroll.
    expect(layout.axis.width + layout.width).toBe(320);
  });

  it("hangs negative bars below a zero line inside the plot", () => {
    const layout = draw({ series: [{ name: "Net", values: [40, -20, 10] }] });
    expect(layout.rules.filter((rule) => rule.strong).map((rule) => rule.key)).toEqual(["y-0"]);
    const zeroY = ruleY(layout, "y-0");
    expect(zeroY).toBeGreaterThan(8);
    expect(zeroY).toBeLessThan(plotBottom(layout));
    const [up, down] = layout.bars;
    expect(up!.y + up!.height).toBeCloseTo(zeroY, 0);
    expect(down!.y).toBeCloseTo(zeroY, 0);
  });

  it("stacks series to their total, and what is below zero downwards", () => {
    const layout = draw({
      chart: "stacked_bar",
      labels: ["Q1"],
      series: [
        { name: "Web", values: [30] },
        { name: "App", values: [70] },
      ],
    });
    const [web, app] = layout.bars;
    expect(layout.axis.texts.at(-1)!.text).toBe("100");
    expect(app!.y).toBeCloseTo(8, 0);
    expect(app!.y + app!.height).toBeCloseTo(web!.y - 1, 0);
    expect(web!.x).toBe(app!.x);

    const mixed = draw({
      chart: "stacked_bar",
      labels: ["Q1"],
      series: [
        { name: "Sales", values: [60] },
        { name: "Refunds", values: [-20] },
        { name: "Fees", values: [-20] },
      ],
      valueLabels: true,
    });
    const zeroY = ruleY(mixed, "y-0");
    const [sales, refunds, fees] = mixed.bars;
    expect(sales!.y + sales!.height).toBeCloseTo(zeroY, 0);
    expect(refunds!.y).toBeCloseTo(zeroY, 0);
    expect(fees!.y).toBeCloseTo(refunds!.y + refunds!.height + 1, 0);
    // A stack says its total once, above what stands over zero.
    expect(keyed(mixed.texts, "v-").map((text) => text.text)).toEqual(["20"]);
  });

  it("breaks a line at a missing value and dots a point left on its own", () => {
    const labels = days(14);
    const values = labels.map((_, index) => (index === 3 || index === 5 ? null : 100 + index));
    const layout = draw({
      chart: "line",
      labelType: "day",
      labels,
      series: [{ name: "Visits", values }],
    });
    const [line] = layout.lines;
    expect(line!.path.match(/M/g)).toHaveLength(3);
    expect(line!.dots.map((dot) => dot.key)).toEqual(["series-0-4"]);
    // A narrow band zooms in instead of flattening against zero.
    expect(layout.axis.texts[0]!.text).not.toBe("0");
    // Dates thin out from the latest, and no two labels share room.
    const xTicks = keyed(layout.texts, "x-");
    expect(xTicks.at(-1)!.text).toBe("14 Jan");
    expect(xTicks.length).toBeLessThan(labels.length);
  });

  it("draws one point, and a chart of zeros, without dividing by nothing", () => {
    const one = draw({ chart: "line", labels: ["Today"], series: [{ name: "Open", values: [7] }] });
    expect(one.lines[0]!.dots).toHaveLength(1);
    expect(one.lines[0]!.dots[0]!.x).toBeGreaterThan(0);
    const zeros = draw({ series: [{ name: "Errors", values: [0, 0, 0] }] });
    expect(zeros.axis.texts.map((tick) => tick.text)).toEqual(["0", "1"]);
    expect(zeros.bars.every((bar) => Number.isFinite(bar.y) && bar.height === 1.5)).toBe(true);
  });

  it("cuts a long category label to its bar's room, so every bar keeps one at phone width", () => {
    const change = {
      labels: ["Enterprise annual contracts", "Self-serve monthly", "Partner referrals", "Other"],
      series: [{ name: "Deals", values: [4, 9, 2, 1] }],
    };
    const layout = draw(change, { width: 260 });
    expect(keyed(layout.texts, "x-").map((tick) => tick.text)).toEqual([
      "Enterpr…",
      "Self-se…",
      "Partner…",
      "Other",
    ]);
    for (const charWidth of [5.5, 6.4, 6.9, 7.5])
      for (const width of [240, 260, 288, 300, 340])
        expect(keyed(draw(change, { width, charWidth }).texts, "x-")).toHaveLength(4);
    expect(keyed(draw(change, { width: 900 }).texts, "x-")[0]!.text).toBe(
      "Enterprise annual contracts",
    );
    for (const tick of keyed(layout.texts, "x-")) {
      const half = (tick.text.length * 6) / 2;
      const [from, to] =
        tick.anchor === "middle"
          ? [tick.x - half, tick.x + half]
          : tick.anchor === "start"
            ? [tick.x, tick.x + half * 2]
            : [tick.x - half * 2, tick.x];
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThanOrEqual(layout.width);
    }
  });

  it("fits a quarter of daily points on a phone, and scrolls a year from its latest day", () => {
    const quarter = days(90);
    const fits = draw({
      chart: "line",
      labelType: "day",
      labels: quarter,
      series: [{ name: "Visits", values: quarter.map((_, index) => index) }],
    });
    expect(fits.axis.width + fits.width).toBe(320);
    expect(fits.startAtEnd).toBe(false);

    const year = days(365);
    const scrolls = draw({
      chart: "bar",
      labelType: "day",
      labels: year,
      series: [
        { name: "Web", values: year.map((_, index) => index) },
        { name: "App", values: year.map((_, index) => index * 2) },
      ],
    });
    expect(scrolls.width).toBeGreaterThan(320);
    expect(scrolls.width).toBeLessThanOrEqual(2400);
    expect(scrolls.startAtEnd).toBe(true);
    expect(scrolls.bars).toHaveLength(730);
    expect(Math.max(...scrolls.bars.map((bar) => bar.x + bar.width))).toBeLessThanOrEqual(
      scrolls.width,
    );
  });

  it("fills an area down to zero, and a stacked area down to the series under it", () => {
    const area = draw({
      chart: "area",
      labels: ["Jan", "Feb", "Mar", "Apr"],
      series: [{ name: "Users", values: [10, 20, null, 30] }],
    });
    // One run of two points is filled; the point after the gap stands alone as a dot.
    expect(area.areas).toHaveLength(1);
    expect(area.areas[0]!.path.endsWith(`${plotBottom(area)}Z`)).toBe(true);
    expect(area.lines[0]!.dots.map((dot) => dot.key)).toContain("series-0-3");

    const stacked = draw({
      chart: "stacked_area",
      labels: ["Jan", "Feb"],
      series: [
        { name: "Free", values: [10, 20] },
        { name: "Paid", values: [30, 20] },
      ],
    });
    const [free, paid] = stacked.lines;
    expect(stacked.axis.texts.at(-1)!.text).toBe("40");
    // Paid rides on Free: its ground is Free's line, drawn back to front.
    const freeEnd = free!.path.split("L").at(-1)!;
    expect(stacked.areas[1]!.path).toContain(`${paid!.path}L${freeEnd}`);
  });

  it("lays horizontal bars a row per label, long names above them on a phone, values at bar ends", () => {
    const change = {
      chart: "horizontal_bar" as const,
      labels: ["Enterprise annual contracts renewed", "Self-serve", "Refunds"],
      series: [{ name: "Net", values: [900, 300, -150] }],
      colors: [null, null, "red" as const],
      valueLabels: true,
      target: { name: "Goal", value: 600 },
    };
    const layout = draw(change);
    // A name too long to sit beside its bar is written whole above it, and the bars get the width.
    expect(layout.axis).toEqual({ width: 0, texts: [] });
    expect(keyed(layout.texts, "y-").map((text) => text.text)).toEqual(change.labels);
    expect(keyed(layout.texts, "y-")[0]!.y).toBeLessThan(layout.bars[0]!.y);
    // With room to spare the names go beside the bars, uncut.
    const wide = draw(change, { width: 700 });
    expect(wide.axis.texts.map((text) => text.text)).toEqual(change.labels);
    expect(wide.axis.width + wide.width).toBe(700);
    const [first, second, refunds] = layout.bars;
    expect(second!.y).toBeGreaterThan(first!.y + first!.height);
    expect(first!.width).toBeCloseTo(second!.width * 3, 0);
    expect(refunds!.x + refunds!.width).toBeCloseTo(first!.x, 0);
    expect(refunds!.tone.color).toBe("red");
    expect(keyed(layout.texts, "v-").map((text) => [text.text, text.anchor])).toEqual([
      ["900", "start"],
      ["300", "start"],
      ["−150", "end"],
    ]);
    for (const text of keyed(layout.texts, "v-")) {
      const wide = text.text.length * 6;
      expect(text.anchor === "start" ? text.x + wide : text.x - wide).toBeGreaterThanOrEqual(0);
      expect(text.anchor === "start" ? text.x + wide : text.x).toBeLessThanOrEqual(layout.width);
    }
    expect(layout.rules.find((rule) => rule.key === "target")).toMatchObject({ dashed: true });
    // Sixty rows is as tall as a card grows.
    const tall = draw({
      chart: "horizontal_bar",
      labels: Array.from({ length: 60 }, (_, index) => `Row ${index}`),
      series: [{ name: "A", values: Array.from({ length: 60 }, () => 1) }],
    });
    expect(tall.height).toBeLessThan(1600);
  });

  it("turns a pie's slices into closed arcs that share the circle, a lone slice into a full ring", () => {
    const layout = draw({
      chart: "pie",
      labels: ["A", "B", "C", "D"],
      series: [{ name: "Share", values: [50, 25, 0, null] }],
    });
    expect(layout.width).toBe(layout.height);
    expect(layout.width).toBeLessThanOrEqual(176);
    expect(layout.axis.width).toBe(0);
    // Nothing is drawn for a slice of nothing or a missing one.
    expect(layout.areas.map((area) => area.key)).toEqual(["slice-0", "slice-1"]);
    expect(layout.areas[0]!.title).toBe("A: 50 · 66.7%");
    // Two thirds of the circle takes the long way round.
    expect(layout.areas[0]!.path).toMatch(/A\S+ \S+ 0 1 1 /);
    expect(layout.areas[1]!.path).toMatch(/A\S+ \S+ 0 0 1 /);

    const whole = draw({ chart: "donut", labels: ["Only"], series: [{ name: "S", values: [7] }] });
    expect(whole.areas[0]!.path.match(/A/g)).toHaveLength(4);
    expect(whole.areas[0]!.path).not.toContain("NaN");
    expect(whole.texts.map((text) => text.text)).toEqual(["7", "Total"]);
  });

  it("spreads a radar's axes round a circle on one scale, and leaves a missing axis open", () => {
    const layout = draw({
      chart: "radar",
      labels: ["Speed", "Cost", "Quality", "Support"],
      series: [
        { name: "Ours", values: [10, 5, 0, 5] },
        { name: "Theirs", values: [4, null, 8, 6] },
      ],
      target: { name: "Bar", value: 7 },
    });
    const [ours, theirs] = layout.lines;
    const [top, right, , left] = ours!.dots;
    const centre = { x: layout.width / 2, y: layout.height / 2 };
    // The first axis points up, the rest follow clockwise, and zero is the centre.
    expect(top!.x).toBeCloseTo(centre.x, 0);
    expect(top!.y).toBeLessThan(centre.y);
    expect(right!.x).toBeGreaterThan(centre.x);
    expect(left!.x).toBeLessThan(centre.x);
    expect(ours!.dots[2]).toMatchObject(centre);
    expect(right!.x - centre.x).toBeCloseTo((centre.y - top!.y) / 2, 0);
    // A whole outline is closed and filled; one with a gap is neither.
    expect(ours!.path.endsWith("Z")).toBe(true);
    expect(theirs!.path).not.toContain("Z");
    expect(theirs!.path.match(/M/g)).toHaveLength(2);
    expect(layout.areas.map((area) => area.key)).toEqual(["series-0-area"]);
    expect(layout.rules.find((rule) => rule.key === "target")).toMatchObject({ dashed: true });
    // Every axis name stays inside the drawing.
    for (const text of keyed(layout.texts, "axis-")) {
      const wide = text.text.length * 6;
      const from =
        text.anchor === "start"
          ? text.x
          : text.anchor === "end"
            ? text.x - wide
            : text.x - wide / 2;
      expect(from).toBeGreaterThanOrEqual(0);
      expect(from + wide).toBeLessThanOrEqual(layout.width);
      expect(text.y).toBeGreaterThan(0);
      expect(text.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("places scatter points on two scales, and names only the points it has room for", () => {
    const layout = draw({
      chart: "scatter",
      labels: [],
      series: [],
      scatter: {
        xName: "Ad spend",
        yName: "Signups",
        xUnit: { kind: "money", currency: "INR" },
        series: [
          {
            name: "Campaigns",
            points: [
              { x: 1000000, y: 10, label: "Launch" },
              { x: 1000000, y: 10, label: "Launch again" },
              { x: 9000000, y: 80, label: "Diwali" },
              { x: -2000000, y: -5 },
            ],
          },
        ],
      },
    });
    const [low, , high, negative] = layout.lines[0]!.dots;
    expect(layout.lines[0]!.path).toBe("");
    expect(high!.x).toBeGreaterThan(low!.x);
    expect(high!.y).toBeLessThan(low!.y);
    expect(negative!.x).toBeLessThan(low!.x);
    // Both axes cross zero, and each says so.
    expect(layout.rules.filter((rule) => rule.strong).map((rule) => rule.key)).toEqual([
      "y-0",
      "x-0",
    ]);
    expect(keyed(layout.texts, "x-").some((text) => text.text.startsWith("₹"))).toBe(true);
    // Two points in one place get one name between them; a point at the edge is named leftwards.
    expect(keyed(layout.texts, "label-").map((text) => [text.text, text.anchor])).toEqual([
      ["Launch", "start"],
      ["Diwali", "end"],
    ]);

    const one = draw({
      chart: "scatter",
      labels: [],
      series: [],
      scatter: {
        xName: "X",
        yName: "Y",
        xUnit: { kind: "count" },
        series: [{ name: "A", points: [{ x: 0, y: 0 }] }],
      },
    });
    expect(one.lines[0]!.dots[0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(Number.isFinite(one.lines[0]!.dots[0]!.x + one.lines[0]!.dots[0]!.y)).toBe(true);
  });

  it("writes values on bars by making room for them, and widens the plot rather than drop any", () => {
    const labels = Array.from({ length: 30 }, (_, index) => `W${index + 1}`);
    const change = {
      labels,
      series: [{ name: "Orders", values: labels.map((_, index) => 1000 + index * 37) }],
    };
    expect(draw(change).width + draw(change).axis.width).toBe(320);
    const written = draw({ ...change, valueLabels: true });
    expect(written.width).toBeGreaterThan(320);
    const values = keyed(written.texts, "v-");
    expect(values).toHaveLength(30);
    const sorted = [...values].sort((a, b) => a.x - b.x);
    for (let index = 1; index < sorted.length; index++)
      expect(sorted[index]!.x - sorted[index - 1]!.x).toBeGreaterThanOrEqual(
        sorted[index]!.text.length * 6,
      );
  });
});
