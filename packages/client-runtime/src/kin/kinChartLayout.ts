import type { KinChartUnit } from "@t3tools/contracts";

import {
  formatKinChartValue,
  kinChartWholeUnit,
  type KinChartSeriesView,
  type KinChartTone,
  type KinChartView,
} from "./kinChart.ts";

export interface KinChartText {
  readonly key: string;
  readonly x: number;
  /** The text's baseline. */
  readonly y: number;
  readonly text: string;
  readonly anchor: "start" | "middle" | "end";
  /** Values and totals read in the foreground colour; axis text is muted. */
  readonly strong: boolean;
}

/**
 * Everything a client draws, as plain shapes in pixels. `width` by `height` is the plot; when it
 * is wider than its room the client scrolls it sideways, with `axis` pinned to its left.
 */
export interface KinChartLayout {
  readonly width: number;
  readonly height: number;
  readonly axis: { readonly width: number; readonly texts: ReadonlyArray<KinChartText> };
  /** A date axis that scrolls opens on its latest end. */
  readonly startAtEnd: boolean;
  readonly rules: ReadonlyArray<{
    readonly key: string;
    readonly path: string;
    /** The zero line and a target stand out from the grid. */
    readonly strong: boolean;
    readonly dashed: boolean;
  }>;
  /** Filled shapes: the ground under a line, a pie's slices, a radar's body. */
  readonly areas: ReadonlyArray<{
    readonly key: string;
    readonly tone: KinChartTone;
    readonly path: string;
    readonly opacity: number;
    readonly title: string | null;
  }>;
  readonly bars: ReadonlyArray<{
    readonly key: string;
    readonly tone: KinChartTone;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    /** A stack's segments meet flat; a bar on its own has soft corners. */
    readonly radius: number;
    readonly title: string;
  }>;
  readonly lines: ReadonlyArray<{
    readonly key: string;
    readonly tone: KinChartTone;
    /** SVG path data, empty for a scatter; a missing value breaks the line. */
    readonly path: string;
    readonly dashed: boolean;
    readonly dots: ReadonlyArray<{
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly r: number;
      readonly title: string;
    }>;
  }>;
  readonly texts: ReadonlyArray<KinChartText>;
}

export interface KinChartSize {
  /** The room the chart has. */
  readonly width: number;
  /** The average glyph width of the axis font. Text is not measured; this keeps labels apart. */
  readonly charWidth?: number;
  readonly fontSize?: number;
}

/** A chart's height for its width: wider cards get a little more room, never a tall one. */
export const kinChartHeight = (width: number) =>
  Math.round(Math.min(200, Math.max(132, width * 0.46)));

const AXIS_LABEL_CHARS = 10;
const MIN_LABEL_CHARS = 4;
const TICKS = 4;
const DOTS_UP_TO = 12;
/** The widest a scrolling plot gets: past this a phone's drawing layer costs too much memory. */
const MAX_PLOT_WIDTH = 2400;
const round = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const cut = (text: string, room: number) => {
  const chars = Array.from(text);
  return chars.length > room ? `${chars.slice(0, Math.max(1, room - 1)).join("")}…` : text;
};
const hLine = (y: number, from: number, to: number) => `M${from} ${y}L${to} ${y}`;
const vLine = (x: number, from: number, to: number) => `M${x} ${from}L${x} ${to}`;

function scaleFor(
  values: ReadonlyArray<number>,
  unit: KinChartUnit,
  options: { readonly fromZero: boolean; readonly ticks?: number },
) {
  let low = Math.min(...values);
  let high = Math.max(...values);
  // Bars are read by length, so they stand on zero. A line may zoom in on a narrow band.
  const zoomed = !options.fromZero && low > 0 && high > low && low > 0.6 * high;
  if (!zoomed) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  // Nothing but zeros: one unit of headroom frames the chart like any other.
  if (low === high) {
    const one = kinChartWholeUnit(unit);
    return { low: 0, high: one, ticks: [0, one] };
  }
  const whole = unit.kind === "money" || values.every(Number.isInteger);
  const raw = (high - low) / (options.ticks ?? TICKS);
  const power = 10 ** Math.floor(Math.log10(raw));
  const size = raw / power;
  let step = (size <= 1 ? 1 : size <= 2 ? 2 : size <= 5 ? 5 : 10) * power;
  if (whole) step = Math.max(1, step);
  const from = Math.floor(low / step + 1e-9);
  const to = Math.ceil(high / step - 1e-9);
  const ticks = Array.from({ length: to - from + 1 }, (_, index) =>
    Number(((from + index) * step).toPrecision(12)),
  );
  return { low: ticks[0]!, high: ticks.at(-1)!, ticks };
}

const present = (series: ReadonlyArray<KinChartSeriesView>) =>
  series.flatMap((one) => one.values.filter((value) => value !== null));

/** The ends of each label's stack: what is above zero piles up, what is below piles down. */
const stackEnds = (view: KinChartView) =>
  view.labels.flatMap((_, index) => {
    let up = 0;
    let down = 0;
    for (const series of view.series) {
      const value = series.values[index] ?? 0;
      if (value >= 0) up += value;
      else down += value;
    }
    return [up, down];
  });

const stackTotal = (view: KinChartView, index: number) =>
  view.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0);

const titleFor = (view: KinChartView) => {
  const many = view.series.length > 1;
  return (series: KinChartSeriesView, index: number, value: number) =>
    `${view.labels[index]!.full}: ${many ? `${series.name} ` : ""}${formatKinChartValue(view.unit, value)}`;
};

interface Frame {
  readonly charWidth: number;
  readonly fontSize: number;
  /** Lifts a baseline so the text sits centred on `y`. */
  readonly middle: (y: number) => number;
}

function vertical(view: KinChartView, width: number, frame: Frame): KinChartLayout {
  const { charWidth, fontSize, middle } = frame;
  const kind = view.kind;
  const lined = kind === "line" || kind === "area" || kind === "stacked_area";
  const stacked = kind === "stacked_bar" || kind === "stacked_area";
  const count = view.labels.length;
  const compact = (value: number) => formatKinChartValue(view.unit, value, "compact");

  const points = stacked ? stackEnds(view) : present(view.series);
  const scale = scaleFor(
    view.target === null ? points : [...points, view.target.value],
    view.unit,
    {
      fromZero: kind !== "line",
    },
  );
  const yLabels = scale.ticks.map(compact);
  const axisWidth = Math.ceil(Math.max(...yLabels.map((text) => text.length)) * charWidth + 8);
  const room = Math.max(40, width - axisWidth);
  const height = kinChartHeight(width);

  // Values are written on one series of points, on every bar, or as a stack's total.
  const labelled =
    view.valueLabels && (lined ? view.series.length === 1 && kind !== "stacked_area" : true);
  const valueTexts = !labelled
    ? []
    : stacked
      ? view.labels.map((_, index) => compact(stackTotal(view, index)))
      : present(view.series).map(compact);
  const valueWidth =
    valueTexts.length === 0
      ? 0
      : Math.max(...valueTexts.map((text) => text.length)) * charWidth + 6;
  const columns = lined || stacked ? 1 : view.series.length;
  const barGap = columns > 1 ? (columns > 4 ? 1 : 2) : 0;
  const inset = 6;
  const least = lined
    ? Math.max(2, valueWidth)
    : Math.max(
        (columns * 3 + barGap * (columns - 1)) / 0.72,
        // One bar's value may overhang into the gap beside it; bars side by side may not.
        columns === 1 ? valueWidth : (columns * valueWidth) / 0.72,
      );
  const needed = lined ? inset * 2 + (count - 1) * least : count * least;
  const plotWidth = Math.round(clamp(needed + 6, room, MAX_PLOT_WIDTH));

  const plot = {
    left: 0,
    right: plotWidth - 6,
    top: 8 + (labelled ? fontSize + 2 : 0),
    bottom: height - 20,
  };
  const plotHeight = Math.max(1, plot.bottom - plot.top);
  const toY = (value: number) =>
    round(plot.bottom - ((value - scale.low) / (scale.high - scale.low)) * plotHeight);
  const band = (plot.right - plot.left) / count;
  const spacing = lined && count > 1 ? (plot.right - plot.left - inset * 2) / (count - 1) : band;
  const toX = (index: number) =>
    round(
      lined && count > 1 ? plot.left + inset + spacing * index : plot.left + band * (index + 0.5),
    );
  // A plot squeezed to its widest may have no room left for the values it was asked to write.
  const writes =
    labelled && (lined || columns === 1 ? spacing : (band * 0.72) / columns) >= valueWidth - 1;

  // A category keeps its label under its own bar, cut to the room it has; dates thin out instead.
  const gap = 10;
  const labelRoom = view.dated
    ? AXIS_LABEL_CHARS
    : Math.max(MIN_LABEL_CHARS, Math.floor((spacing - gap) / charWidth));
  const short = view.labels.map((one) => cut(one.short, labelRoom));
  const widest = Math.max(...short.map((text) => text.length)) * charWidth + gap;
  const every = Math.max(1, Math.ceil(widest / spacing));
  const texts: Array<KinChartText> = short.flatMap((text, index) => {
    const offset = view.dated ? count - 1 - index : index;
    if (offset % every !== 0) return [];
    const x = toX(index);
    const half = (text.length * charWidth) / 2;
    const anchor = x - half < 0 ? "start" : x + half > plotWidth ? "end" : "middle";
    return [
      {
        key: `x-${index}`,
        x: anchor === "start" ? 0 : anchor === "end" ? plotWidth : x,
        y: height - 5,
        text,
        anchor,
        strong: false,
      } as const,
    ];
  });

  // A value centred over the first or last point is nudged in, so the plot's edge never cuts it.
  const inside = (x: number, text: string) => {
    const half = (text.length * charWidth) / 2;
    return round(clamp(x, half, Math.max(half, plotWidth - half)));
  };
  const title = titleFor(view);
  const bars: Array<KinChartLayout["bars"][number]> = [];
  const areas: Array<KinChartLayout["areas"][number]> = [];
  let lines: KinChartLayout["lines"] = [];

  if (!lined) {
    const barWidth = Math.max(
      1,
      Math.min(
        Math.max(40, writes ? valueWidth : 0),
        (band * 0.72 - barGap * (columns - 1)) / columns,
      ),
    );
    const groupWidth = barWidth * columns + barGap * (columns - 1);
    const floor = toY(0);
    for (let index = 0; index < count; index++) {
      const start = plot.left + band * (index + 0.5) - groupWidth / 2;
      let up = 0;
      let down = 0;
      view.series.forEach((series, column) => {
        const value = series.values[index] ?? null;
        if (value === null) return;
        const base = !stacked ? 0 : value < 0 ? down : up;
        if (value < 0) down += value;
        else up += value;
        const from = stacked ? toY(base) : floor;
        const to = toY(base + value);
        // A zero still leaves a mark, so it never reads as a missing value. Stacked segments
        // keep a hairline between them.
        const tall = Math.max(1.5, Math.abs(from - to) - (stacked && base !== 0 ? 1 : 0));
        const x = round(start + (stacked ? 0 : column * (barWidth + barGap)));
        const y = round(value < 0 ? Math.max(to - tall, from) : Math.min(to, from - tall));
        bars.push({
          key: `${series.key}-${index}`,
          tone: view.labelTones?.[index] ?? series.tone,
          x,
          y,
          width: round(barWidth),
          height: round(tall),
          radius: stacked ? 0 : 2,
          title: title(series, index, value),
        });
        if (writes && !stacked)
          texts.push({
            key: `v-${series.key}-${index}`,
            x: inside(x + barWidth / 2, compact(value)),
            y: value < 0 ? round(y + tall + fontSize) : y - 3,
            text: compact(value),
            anchor: "middle",
            strong: true,
          });
      });
      if (
        writes &&
        stacked &&
        view.series.some((series) => (series.values[index] ?? null) !== null)
      )
        texts.push({
          key: `v-total-${index}`,
          x: inside(toX(index), compact(stackTotal(view, index))),
          y: toY(up) - 3,
          text: compact(stackTotal(view, index)),
          anchor: "middle",
          strong: true,
        });
    }
  } else {
    const floor = toY(clamp(0, scale.low, scale.high));
    const below = view.labels.map(() => 0);
    lines = view.series.map((series) => {
      const points = series.values.map((value, index) => {
        if (value === null && kind !== "stacked_area") return null;
        const base = below[index]!;
        const top = kind === "stacked_area" ? base + (value ?? 0) : value!;
        below[index] = top;
        return { index, value, x: toX(index), y: toY(top), baseY: toY(base) };
      });
      // Each unbroken run is one stroke, and one filled shape down to what is under it.
      const runs: Array<Array<NonNullable<(typeof points)[number]>>> = [];
      points.forEach((point, index) => {
        if (point === null) return;
        if (index === 0 || points[index - 1] === null) runs.push([]);
        runs.at(-1)!.push(point);
      });
      const stroke = (run: (typeof runs)[number]) =>
        run.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
      if (kind !== "line")
        runs.forEach((run, index) => {
          if (run.length < 2) return;
          const back = [...run]
            .reverse()
            .map((point) => `L${point.x} ${kind === "stacked_area" ? point.baseY : floor}`)
            .join("");
          areas.push({
            key: `${series.key}-area-${index}`,
            tone: series.tone,
            path: `${stroke(run)}${back}Z`,
            opacity: kind === "stacked_area" ? 0.55 : series.previous ? 0.08 : 0.16,
            title: null,
          });
        });
      const alone = (index: number) =>
        (points[index - 1] ?? null) === null && (points[index + 1] ?? null) === null;
      return {
        key: series.key,
        tone: series.tone,
        path: runs.map(stroke).join(""),
        dashed: series.previous,
        dots: points.flatMap((point) => {
          if (point === null || point.value === null) return [];
          if (count > DOTS_UP_TO && !alone(point.index)) return [];
          return [
            {
              key: `${series.key}-${point.index}`,
              x: point.x,
              y: point.y,
              r: 2.5,
              title: title(series, point.index, point.value),
            },
          ];
        }),
      };
    });
    if (writes)
      view.series[0]!.values.forEach((value, index) => {
        if (value === null) return;
        const y = toY(value);
        texts.push({
          key: `v-${index}`,
          x: inside(toX(index), compact(value)),
          y: y - 6 < plot.top - fontSize ? y + fontSize + 4 : y - 6,
          text: compact(value),
          anchor: "middle",
          strong: true,
        });
      });
  }

  const startAtEnd = view.dated && plotWidth > room;
  const rules: Array<KinChartLayout["rules"][number]> = scale.ticks.map((tick) => ({
    key: `y-${tick}`,
    path: hLine(toY(tick), plot.left, plot.right),
    strong: tick === 0 && scale.low < 0 && scale.high > 0,
    dashed: false,
  }));
  if (view.target !== null) {
    const y = toY(view.target.value);
    rules.push({
      key: "target",
      path: hLine(y, plot.left, plot.right),
      strong: true,
      dashed: true,
    });
  }

  return {
    width: plotWidth,
    height,
    axis: {
      width: axisWidth,
      texts: scale.ticks.map((tick, index) => ({
        key: `y-${tick}`,
        x: axisWidth - 6,
        y: middle(toY(tick)),
        text: yLabels[index]!,
        anchor: "end",
        strong: false,
      })),
    },
    startAtEnd,
    rules,
    areas,
    bars,
    lines,
    texts,
  };
}

function horizontal(view: KinChartView, width: number, frame: Frame): KinChartLayout {
  const { charWidth, fontSize, middle } = frame;
  const stacked = view.kind === "stacked_horizontal_bar";
  const count = view.labels.length;
  const columns = stacked ? 1 : view.series.length;
  const compact = (value: number) => formatKinChartValue(view.unit, value, "compact");

  const points = stacked ? stackEnds(view) : present(view.series);
  const all = view.target === null ? points : [...points, view.target.value];
  const scale = scaleFor(all, view.unit, { fromZero: true, ticks: width < 420 ? 3 : TICKS });

  const longest = Math.max(...view.labels.map((one) => Array.from(one.short).length));
  // Names that would be cut beside their bars are written in full above them instead.
  const above = longest * charWidth + 10 > width * 0.38;
  const axisWidth = above ? 0 : Math.ceil(longest * charWidth + 10);
  const plotWidth = Math.max(40, width - axisWidth);
  const labelRoom = Math.max(MIN_LABEL_CHARS, Math.floor(plotWidth / charWidth));
  const nameHeight = above ? fontSize + 5 : 0;

  const valueTexts = !view.valueLabels
    ? []
    : stacked
      ? view.labels.map((_, index) => compact(stackTotal(view, index)))
      : points.map(compact);
  const valueWidth =
    valueTexts.length === 0
      ? 0
      : Math.max(...valueTexts.map((text) => text.length)) * charWidth + 6;
  // Values sit past the end of their bars, so the bars give up that much room.
  const writes = view.valueLabels && plotWidth - valueWidth * (scale.low < 0 ? 2 : 1) >= 60;
  const plot = {
    left: writes && scale.low < 0 ? valueWidth : 1,
    right: plotWidth - (writes ? valueWidth : 8),
  };
  const toX = (value: number) =>
    round(plot.left + ((value - scale.low) / (scale.high - scale.low)) * (plot.right - plot.left));

  const thick = columns === 1 ? 14 : columns <= 3 ? 9 : 6;
  const barGap = columns > 1 ? (columns > 4 ? 1 : 2) : 0;
  const rowHeight = nameHeight + thick * columns + barGap * (columns - 1) + 10;
  const top = 4;
  const bottom = top + rowHeight * count;
  const height = bottom + 20;

  const tickLabels = scale.ticks.map(compact);
  const tickGap =
    (plot.right - plot.left) / Math.max(1, scale.ticks.length - 1) -
    Math.max(...tickLabels.map((text) => text.length)) * charWidth;
  const every = tickGap >= 8 ? 1 : 2;
  const texts: Array<KinChartText> = scale.ticks.flatMap((tick, index) => {
    if (index % every !== 0) return [];
    const x = toX(tick);
    const half = (tickLabels[index]!.length * charWidth) / 2;
    const anchor = x - half < 0 ? "start" : x + half > plotWidth ? "end" : "middle";
    return [
      {
        key: `x-${tick}`,
        x: anchor === "start" ? 0 : anchor === "end" ? plotWidth : x,
        y: height - 5,
        text: tickLabels[index]!,
        anchor,
        strong: false,
      } as const,
    ];
  });

  const title = titleFor(view);
  const bars: Array<KinChartLayout["bars"][number]> = [];
  const zero = toX(0);
  for (let index = 0; index < count; index++) {
    const rowTop = top + rowHeight * index + 5 + nameHeight;
    if (above)
      texts.push({
        key: `y-${index}`,
        x: 0,
        y: rowTop - 5,
        text: cut(view.labels[index]!.short, labelRoom),
        anchor: "start",
        strong: false,
      });
    let up = 0;
    let down = 0;
    view.series.forEach((series, column) => {
      const value = series.values[index] ?? null;
      if (value === null) return;
      const base = !stacked ? 0 : value < 0 ? down : up;
      if (value < 0) down += value;
      else up += value;
      const from = stacked ? toX(base) : zero;
      const to = toX(base + value);
      const long = Math.max(1.5, Math.abs(to - from) - (stacked && base !== 0 ? 1 : 0));
      const x = round(value < 0 ? Math.min(to, from - long) : Math.max(to - long, from));
      const y = round(rowTop + (stacked ? 0 : column * (thick + barGap)));
      bars.push({
        key: `${series.key}-${index}`,
        tone: view.labelTones?.[index] ?? series.tone,
        x,
        y,
        width: round(long),
        height: thick,
        radius: stacked ? 0 : 2,
        title: title(series, index, value),
      });
      if (writes && !stacked)
        texts.push({
          key: `v-${series.key}-${index}`,
          x: value < 0 ? x - 4 : round(x + long + 4),
          y: middle(y + thick / 2),
          text: compact(value),
          anchor: value < 0 ? "end" : "start",
          strong: true,
        });
    });
    if (writes && stacked && view.series.some((series) => (series.values[index] ?? null) !== null))
      texts.push({
        key: `v-total-${index}`,
        x: toX(up) + 4,
        y: middle(rowTop + thick / 2),
        text: compact(stackTotal(view, index)),
        anchor: "start",
        strong: true,
      });
  }

  // With names written above the bars, a rule runs only beside the bars, never through a name.
  const barsHeight = rowHeight - nameHeight - 10;
  const rule = (x: number) =>
    above
      ? view.labels
          .map((_, index) => {
            const from = top + rowHeight * index + nameHeight + 3;
            return vLine(x, from, from + barsHeight + 4);
          })
          .join("")
      : vLine(x, top, bottom);
  const rules: Array<KinChartLayout["rules"][number]> = scale.ticks.map((tick) => ({
    key: `x-${tick}`,
    path: rule(toX(tick)),
    strong: tick === 0 && scale.low < 0 && scale.high > 0,
    dashed: false,
  }));
  if (view.target !== null) {
    const x = toX(view.target.value);
    rules.push({ key: "target", path: rule(x), strong: true, dashed: true });
  }

  return {
    width: plotWidth,
    height,
    axis: {
      width: axisWidth,
      texts: above
        ? []
        : view.labels.map((one, index) => ({
            key: `y-${index}`,
            x: axisWidth - 8,
            y: middle(top + rowHeight * (index + 0.5)),
            text: one.short,
            anchor: "end" as const,
            strong: false,
          })),
    },
    startAtEnd: false,
    rules,
    areas: [],
    bars,
    lines: [],
    texts,
  };
}

function pie(view: KinChartView, width: number, frame: Frame): KinChartLayout {
  const size = Math.round(Math.min(width, clamp(width * 0.5, 128, 176)));
  const centre = size / 2;
  const outer = centre - 1;
  const inner = view.kind === "donut" ? round(outer * 0.62) : 0;
  const drawn = view.slices.filter((slice) => slice.value > 0);
  const total = drawn.reduce((sum, slice) => sum + slice.value, 0);
  const at = (radius: number, angle: number) =>
    `${round(centre + radius * Math.sin(angle))} ${round(centre - radius * Math.cos(angle))}`;
  // A hair of space between slices, which a sliver too thin to spare it goes without.
  const pad = drawn.length > 1 ? 0.6 / outer : 0;
  let turned = 0;
  const areas = drawn.map((slice) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const inset = sweep > pad * 4 ? pad : 0;
    const from = turned + inset;
    const to = turned + sweep - inset;
    turned += sweep;
    const big = to - from > Math.PI ? 1 : 0;
    // One slice of everything is a full turn, which an arc can't close: draw it as two halves.
    const whole = to - from > Math.PI * 2 - 1e-6;
    const ring = (radius: number, sweepFlag: 0 | 1, start: number, end: number) =>
      whole
        ? `A${radius} ${radius} 0 1 ${sweepFlag} ${at(radius, start + Math.PI)}A${radius} ${radius} 0 1 ${sweepFlag} ${at(radius, end)}`
        : `A${radius} ${radius} 0 ${big} ${sweepFlag} ${at(radius, end)}`;
    const path =
      inner === 0
        ? whole
          ? `M${at(outer, from)}${ring(outer, 1, from, to)}Z`
          : `M${centre} ${centre}L${at(outer, from)}${ring(outer, 1, from, to)}Z`
        : `M${at(outer, from)}${ring(outer, 1, from, to)}${whole ? "M" : "L"}${at(inner, to)}${ring(inner, 0, to, from)}Z`;
    return {
      key: slice.key,
      tone: slice.tone,
      path,
      opacity: 1,
      title: `${slice.name}: ${slice.detail}`,
    };
  });
  const texts: ReadonlyArray<KinChartText> =
    inner === 0 || view.total === null
      ? []
      : [
          {
            key: "total",
            x: centre,
            y: frame.middle(centre - 3),
            text: view.total,
            anchor: "middle",
            strong: true,
          },
          {
            key: "total-name",
            x: centre,
            y: frame.middle(centre + frame.fontSize),
            text: "Total",
            anchor: "middle",
            strong: false,
          },
        ];
  return {
    width: size,
    height: size,
    axis: { width: 0, texts: [] },
    startAtEnd: false,
    rules: [],
    areas,
    bars: [],
    lines: [],
    texts,
  };
}

function radar(view: KinChartView, width: number, frame: Frame): KinChartLayout {
  const { charWidth, fontSize, middle } = frame;
  const count = view.labels.length;
  const size = Math.min(width, 420);
  const labelRoom = clamp(Math.floor((size * 0.26) / charWidth), 5, 18);
  const short = view.labels.map((one) => cut(one.short, labelRoom));
  const side = Math.max(...short.map((text) => text.length)) * charWidth + 10;
  const radius = Math.round(clamp(size / 2 - side, 36, 120));
  const height = radius * 2 + (fontSize + 12) * 2;
  const cx = size / 2;
  const cy = height / 2;

  const values = present(view.series);
  const scale = scaleFor(
    view.target === null ? values : [...values, view.target.value],
    view.unit,
    {
      fromZero: true,
      ticks: 3,
    },
  );
  const spot = (index: number, value: number) => {
    const angle = (index / count) * Math.PI * 2;
    const reach = (value / scale.high) * radius;
    return { x: round(cx + reach * Math.sin(angle)), y: round(cy - reach * Math.cos(angle)) };
  };
  const ringAt = (value: number) =>
    `${view.labels
      .map((_, index) => {
        const point = spot(index, value);
        return `${index === 0 ? "M" : "L"}${point.x} ${point.y}`;
      })
      .join("")}Z`;

  const rings = scale.ticks.filter((tick) => tick > 0);
  const rules: Array<KinChartLayout["rules"][number]> = [
    ...rings.map((tick) => ({
      key: `ring-${tick}`,
      path: ringAt(tick),
      strong: false,
      dashed: false,
    })),
    {
      key: "spokes",
      path: view.labels
        .map((_, index) => {
          const end = spot(index, scale.high);
          return `M${cx} ${cy}L${end.x} ${end.y}`;
        })
        .join(""),
      strong: false,
      dashed: false,
    },
  ];
  // One number says the scale: the outer ring's, beside the top axis.
  const texts: Array<KinChartText> = [
    {
      key: "ring-max",
      x: cx - 4,
      y: cy - radius + fontSize + 1,
      text: formatKinChartValue(view.unit, scale.high, "compact"),
      anchor: "end",
      strong: false,
    },
    ...short.map((text, index) => {
      const angle = (index / count) * Math.PI * 2;
      const across = Math.sin(angle);
      const up = Math.cos(angle);
      const x = round(cx + (radius + 8) * across);
      const y = cy - (radius + 8) * up;
      return {
        key: `axis-${index}`,
        x,
        y: round(up > 0.3 ? y - 1 : up < -0.3 ? y + fontSize - 1 : middle(y)),
        text,
        anchor:
          across > 0.2
            ? ("start" as const)
            : across < -0.2
              ? ("end" as const)
              : ("middle" as const),
        strong: false,
      };
    }),
  ];
  if (view.target !== null) {
    rules.push({ key: "target", path: ringAt(view.target.value), strong: true, dashed: true });
  }

  const title = titleFor(view);
  const areas: Array<KinChartLayout["areas"][number]> = [];
  const lines = view.series.map((series) => {
    const points = series.values.map((value, index) =>
      value === null ? null : { index, value, ...spot(index, value) },
    );
    const complete = points.every((point) => point !== null);
    // Round the circle: a side is drawn only between two axes that both have a value.
    const sides = points.flatMap((point, index) => {
      const next = points[(index + 1) % count] ?? null;
      return point === null || next === null ? [] : [`M${point.x} ${point.y}L${next.x} ${next.y}`];
    });
    const outline = complete
      ? `${points.map((point, index) => `${index === 0 ? "M" : "L"}${point!.x} ${point!.y}`).join("")}Z`
      : sides.join("");
    if (complete && !series.previous)
      areas.push({
        key: `${series.key}-area`,
        tone: series.tone,
        path: outline,
        opacity: 0.14,
        title: null,
      });
    const alone = (index: number) =>
      (points[(index + count - 1) % count] ?? null) === null &&
      (points[(index + 1) % count] ?? null) === null;
    return {
      key: series.key,
      tone: series.tone,
      path: outline,
      dashed: series.previous,
      dots: points.flatMap((point) =>
        point !== null && (count <= DOTS_UP_TO || alone(point.index))
          ? [
              {
                key: `${series.key}-${point.index}`,
                x: point.x,
                y: point.y,
                r: 2.5,
                title: title(series, point.index, point.value),
              },
            ]
          : [],
      ),
    };
  });

  return {
    width: size,
    height,
    axis: { width: 0, texts: [] },
    startAtEnd: false,
    rules,
    areas,
    bars: [],
    lines,
    texts,
  };
}

const POINT_LABEL_CHARS = 18;

function scatter(view: KinChartView, width: number, frame: Frame): KinChartLayout {
  const { charWidth, fontSize, middle } = frame;
  const { xUnit, series } = view.scatter!;
  const points = series.flatMap((one) => one.points);
  const ys = points.map((point) => point.y);
  const yScale = scaleFor(view.target === null ? ys : [...ys, view.target.value], view.unit, {
    fromZero: false,
  });
  const xScale = scaleFor(
    points.map((point) => point.x),
    xUnit,
    { fromZero: false, ticks: width < 420 ? 3 : TICKS + 1 },
  );
  const yLabels = yScale.ticks.map((tick) => formatKinChartValue(view.unit, tick, "compact"));
  const xLabels = xScale.ticks.map((tick) => formatKinChartValue(xUnit, tick, "compact"));
  const axisWidth = Math.ceil(Math.max(...yLabels.map((text) => text.length)) * charWidth + 8);
  const plotWidth = Math.max(40, width - axisWidth);
  const height = Math.round(clamp(width * 0.6, 168, 260));
  const plot = {
    left: 6,
    right: plotWidth - 10,
    top: 8,
    bottom: height - 20,
  };
  const toX = (value: number) =>
    round(
      plot.left + ((value - xScale.low) / (xScale.high - xScale.low)) * (plot.right - plot.left),
    );
  const toY = (value: number) =>
    round(
      plot.bottom - ((value - yScale.low) / (yScale.high - yScale.low)) * (plot.bottom - plot.top),
    );

  const tickGap =
    (plot.right - plot.left) / Math.max(1, xScale.ticks.length - 1) -
    Math.max(...xLabels.map((text) => text.length)) * charWidth;
  const every = tickGap >= 8 ? 1 : 2;
  const texts: Array<KinChartText> = xScale.ticks.flatMap((tick, index) => {
    if (index % every !== 0) return [];
    const x = toX(tick);
    const half = (xLabels[index]!.length * charWidth) / 2;
    const anchor = x - half < 0 ? "start" : x + half > plotWidth ? "end" : "middle";
    return [
      {
        key: `x-${tick}`,
        x: anchor === "start" ? 0 : anchor === "end" ? plotWidth : x,
        y: height - 5,
        text: xLabels[index]!,
        anchor,
        strong: false,
      } as const,
    ];
  });

  // A name is written beside its point only where it covers no other name or point; the table
  // has all.
  const taken: Array<{ left: number; right: number; top: number; bottom: number }> = series.flatMap(
    (one) =>
      one.points.map((point) => ({
        left: toX(point.x) - 4,
        right: toX(point.x) + 4,
        top: toY(point.y) - 4,
        bottom: toY(point.y) + 4,
      })),
  );
  for (const one of series)
    for (const point of one.points) {
      if (point.label === null) continue;
      const text = cut(point.label, POINT_LABEL_CHARS);
      const wide = text.length * charWidth;
      const x = toX(point.x);
      const y = toY(point.y);
      const onRight = x + 6 + wide <= plotWidth;
      if (!onRight && x - 6 - wide < 0) continue;
      const box = {
        left: onRight ? x + 6 : x - 6 - wide,
        right: onRight ? x + 6 + wide : x - 6,
        top: y - fontSize / 2 - 1,
        bottom: y + fontSize / 2 + 1,
      };
      if (
        taken.some(
          (other) =>
            box.left < other.right &&
            other.left < box.right &&
            box.top < other.bottom &&
            other.top < box.bottom,
        )
      )
        continue;
      taken.push(box);
      texts.push({
        key: `label-${point.key}`,
        x: onRight ? box.left : box.right,
        y: middle(y),
        text,
        anchor: onRight ? "start" : "end",
        strong: false,
      });
    }

  const rules: Array<KinChartLayout["rules"][number]> = [
    ...yScale.ticks.map((tick) => ({
      key: `y-${tick}`,
      path: hLine(toY(tick), 0, plot.right),
      strong: tick === 0 && yScale.low < 0 && yScale.high > 0,
      dashed: false,
    })),
    ...xScale.ticks.flatMap((tick) =>
      tick === 0 && xScale.low < 0 && xScale.high > 0
        ? [
            {
              key: `x-${tick}`,
              path: vLine(toX(tick), plot.top, plot.bottom),
              strong: true,
              dashed: false,
            },
          ]
        : [],
    ),
  ];
  if (view.target !== null) {
    const y = toY(view.target.value);
    rules.push({ key: "target", path: hLine(y, 0, plot.right), strong: true, dashed: true });
  }

  return {
    width: plotWidth,
    height,
    axis: {
      width: axisWidth,
      texts: yScale.ticks.map((tick, index) => ({
        key: `y-${tick}`,
        x: axisWidth - 6,
        y: middle(toY(tick)),
        text: yLabels[index]!,
        anchor: "end",
        strong: false,
      })),
    },
    startAtEnd: false,
    rules,
    areas: [],
    bars: [],
    lines: series.map((one) => ({
      key: one.key,
      tone: one.tone,
      path: "",
      dashed: false,
      dots: one.points.map((point) => ({
        key: point.key,
        x: toX(point.x),
        y: toY(point.y),
        r: 3.5,
        title: point.title,
      })),
    })),
    texts,
  };
}

/** Where everything goes in the room a chart has, in pixels. */
export function kinChartLayout(view: KinChartView, size: KinChartSize): KinChartLayout {
  const fontSize = size.fontSize ?? 10;
  const frame: Frame = {
    charWidth: size.charWidth ?? 6,
    fontSize,
    middle: (y) => round(y + fontSize * 0.35),
  };
  switch (view.kind) {
    case "pie":
    case "donut":
      return pie(view, size.width, frame);
    case "radar":
      return radar(view, size.width, frame);
    case "scatter":
      return scatter(view, size.width, frame);
    case "horizontal_bar":
    case "stacked_horizontal_bar":
      return horizontal(view, size.width, frame);
    default:
      return vertical(view, size.width, frame);
  }
}
