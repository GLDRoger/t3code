import {
  KinChartCardState,
  type KinChartKind,
  type KinChartSpec,
  type KinChartUnit,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinSentences } from "./kinScreenState.ts";

/** Which of the product's colours a series takes; `previous` is the muted comparison. */
export type KinChartTone = "one" | "two" | "three" | "four" | "previous";

export interface KinChartSeriesView {
  readonly key: string;
  readonly name: string;
  readonly tone: KinChartTone;
  readonly values: ReadonlyArray<number | null>;
}

export interface KinChartView {
  readonly kind: KinChartKind;
  readonly title: string;
  readonly caption: string | null;
  readonly unit: KinChartUnit;
  /** `short` fits an axis; `full` is what the table and the summary say. */
  readonly labels: ReadonlyArray<{ readonly short: string; readonly full: string }>;
  /** Latest labels matter most on a date axis, so thinning keeps the last one. */
  readonly dated: boolean;
  /** In drawing order: the comparison sits behind and to the left of its series. */
  readonly series: ReadonlyArray<KinChartSeriesView>;
  /** Empty when a single series needs no key. */
  readonly legend: ReadonlyArray<Pick<KinChartSeriesView, "key" | "name" | "tone">>;
  readonly table: {
    readonly columns: ReadonlyArray<string>;
    readonly rows: ReadonlyArray<{
      readonly key: string;
      readonly label: string;
      readonly cells: ReadonlyArray<string>;
    }>;
  };
  /** The whole chart in words, for a screen reader. */
  readonly summary: string;
}

const MINUS = "−";
const MISSING = "–";
const NO_MINOR_UNIT = new Set(
  "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF".split(" "),
);
const THREE_MINOR_DIGITS = new Set("BHD IQD JOD KWD LYD OMR TND".split(" "));
const SYMBOLS: Readonly<Record<string, string>> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "CN¥",
  AUD: "A$",
  CAD: "CA$",
  SGD: "S$",
  HKD: "HK$",
  NZD: "NZ$",
};

const minorDigits = (currency: string) =>
  NO_MINOR_UNIT.has(currency) ? 0 : THREE_MINOR_DIGITS.has(currency) ? 3 : 2;
const symbol = (currency: string) => SYMBOLS[currency] ?? `${currency} `;

// Indian grouping: the last three digits, then pairs (12,34,567).
const group = (digits: string, indian: boolean) =>
  indian && digits.length > 3
    ? `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`
    : digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const trimmed = (value: number, digits: number) => {
  const text = value.toFixed(digits);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
};

const decimal = (value: number, indian: boolean) => {
  const [whole, fraction] = trimmed(value, 2).split(".");
  return `${group(whole!, indian)}${fraction === undefined ? "" : `.${fraction}`}`;
};

const SCALES = {
  indian: [
    [1e7, "Cr"],
    [1e5, "L"],
    [1e3, "K"],
  ],
  western: [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ],
} as const;

const compact = (value: number, indian: boolean) => {
  for (const [size, suffix] of SCALES[indian ? "indian" : "western"])
    if (value >= size) return `${trimmed(value / size, 2)}${suffix}`;
  return trimmed(value, 2);
};

/**
 * A chart value as text. Money arrives in whole minor units and is split with integer maths, so
 * the full form is exact; INR groups in lakh and crore. `compact` is for an axis.
 */
export function formatKinChartValue(
  unit: KinChartUnit,
  value: number,
  style: "full" | "compact" = "full",
  /** Show a currency's minor digits even when they are zero, so a column lines up. */
  keepMinor = false,
): string {
  const sign = value < 0 ? MINUS : "";
  const size = Math.abs(value);
  if (unit.kind === "percent") return `${sign}${trimmed(size, 2)}%`;
  if (unit.kind === "count")
    return `${sign}${style === "compact" ? compact(size, false) : decimal(size, false)}`;
  const digits = minorDigits(unit.currency);
  const indian = unit.currency === "INR";
  const scale = 10 ** digits;
  if (style === "compact") return `${sign}${symbol(unit.currency)}${compact(size / scale, indian)}`;
  const minor = size % scale;
  const fraction =
    digits > 0 && (keepMinor || minor !== 0) ? `.${String(minor).padStart(digits, "0")}` : "";
  return `${sign}${symbol(unit.currency)}${group(String(Math.floor(size / scale)), indian)}${fraction}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const label = (spec: KinChartSpec, text: string) => {
  if (spec.labelType === "category") return { short: text, full: text };
  const [year, month, day] = text.split("-");
  const name = MONTHS[Number(month) - 1]!;
  if (spec.labelType === "day") {
    const short = `${Number(day)} ${name}`;
    return { short, full: `${short} ${year}` };
  }
  // A new year is the one place a month axis needs its year.
  return { short: month === "01" ? `${name} ’${year!.slice(2)}` : name, full: `${name} ${year}` };
};

const TONES = ["one", "two", "three", "four"] as const;
const KIND_NAMES: Record<KinChartKind, string> = {
  line: "Line chart",
  bar: "Bar chart",
  stacked_bar: "Stacked bar chart",
};

/** A chart ready to draw, from a spec that already passed `kinChartProblem`. */
export function kinChartView(spec: KinChartSpec): KinChartView {
  const labels = spec.labels.map((text) => label(spec, text));
  const current = spec.series.map((series, index): KinChartSeriesView => ({
    key: `series-${index}`,
    name: series.name,
    tone: TONES[index] ?? "four",
    values: series.values,
  }));
  const previous: ReadonlyArray<KinChartSeriesView> =
    spec.comparison === null
      ? []
      : [
          {
            key: "previous",
            name: spec.comparison.name,
            tone: "previous",
            values: spec.comparison.values,
          },
        ];
  // People read the current period first, whatever is drawn first.
  const read = [...current, ...previous];
  const values = read.flatMap((series) => series.values);
  const minorScale = spec.unit.kind === "money" ? 10 ** minorDigits(spec.unit.currency) : 1;
  const keepMinor = values.some((value) => value !== null && value % minorScale !== 0);
  const full = (value: number | null) =>
    value === null ? MISSING : formatKinChartValue(spec.unit, value, "full", keepMinor);

  const described = read.map((series) => {
    const points = series.values.flatMap((value, index) =>
      value === null ? [] : [{ value, at: labels[index]!.full }],
    );
    if (points.length === 0) return `${series.name}: no values`;
    const say = (point: (typeof points)[number]) => `${full(point.value)} (${point.at})`;
    const first = points[0]!;
    if (points.length === 1) return `${series.name}: ${say(first)}`;
    const highest = points.reduce((a, b) => (b.value > a.value ? b : a));
    const lowest = points.reduce((a, b) => (b.value < a.value ? b : a));
    return `${series.name}: ${say(first)} to ${say(points.at(-1)!)}; highest ${say(highest)}, lowest ${say(lowest)}`;
  });
  const missing = values.filter((value) => value === null).length;

  return {
    kind: spec.chart,
    title: spec.title,
    caption: spec.caption,
    unit: spec.unit,
    labels,
    dated: spec.labelType !== "category",
    series: [...previous, ...current],
    legend: read.length > 1 ? read.map(({ key, name, tone }) => ({ key, name, tone })) : [],
    table: {
      columns: read.map((series) => series.name),
      rows: labels.map((one, index) => ({
        key: `row-${index}`,
        label: one.full,
        cells: read.map((series) => full(series.values[index] ?? null)),
      })),
    },
    summary: kinSentences([
      `${KIND_NAMES[spec.chart]}: ${spec.title}`,
      ...described,
      missing === 0 ? null : `${missing} ${missing === 1 ? "value is" : "values are"} missing`,
      spec.caption,
    ]),
  };
}

const decode = Schema.decodeUnknownOption(KinChartCardState);

/** A chat card's chart, or null when this build can't read it. */
export function kinChartCardView(widget: KinWidget): KinChartView | null {
  const state = decode(widget.state);
  return Option.isSome(state) ? kinChartView(state.value) : null;
}

export interface KinChartLayout {
  readonly width: number;
  readonly height: number;
  readonly plot: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly yTicks: ReadonlyArray<{
    readonly value: number;
    readonly y: number;
    readonly label: string;
  }>;
  /** Where zero sits when the chart crosses it, so bars have a floor to stand on. */
  readonly zeroY: number | null;
  readonly xTicks: ReadonlyArray<{
    readonly key: string;
    readonly x: number;
    readonly label: string;
    readonly anchor: "start" | "middle" | "end";
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
    /** SVG path data; a missing value breaks the line. */
    readonly path: string;
    readonly dots: ReadonlyArray<{
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly title: string;
    }>;
  }>;
}

/** A chart's height for its width: wider cards get a little more room, never a tall one. */
export const kinChartHeight = (width: number) =>
  Math.round(Math.min(200, Math.max(132, width * 0.46)));

const AXIS_LABEL_CHARS = 10;
const MIN_LABEL_CHARS = 4;
const TICKS = 4;
const DOTS_UP_TO = 12;
const round = (value: number) => Math.round(value * 10) / 10;

function domain(view: KinChartView) {
  const stacked = view.kind === "stacked_bar";
  const points = stacked
    ? view.labels.map((_, index) =>
        view.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
      )
    : view.series.flatMap((series) => series.values.filter((value) => value !== null));
  let low = Math.min(...points);
  let high = Math.max(...points);
  // Bars are read by length, so they stand on zero. A line may zoom in on a narrow band.
  const zoomed = view.kind === "line" && low > 0 && high > low && low > 0.6 * high;
  if (!zoomed) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  // Nothing but zeros: one unit of headroom frames the chart like any other.
  if (low === high) {
    const one = view.unit.kind === "money" ? 10 ** minorDigits(view.unit.currency) : 1;
    return { low: 0, high: one, ticks: [0, one] };
  }
  const whole =
    view.unit.kind === "money" ||
    view.series.every((series) => series.values.every((v) => v === null || Number.isInteger(v)));
  const raw = (high - low) / TICKS;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  let step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
  if (whole) step = Math.max(1, step);
  const from = Math.floor(low / step + 1e-9);
  const to = Math.ceil(high / step - 1e-9);
  const ticks = Array.from({ length: to - from + 1 }, (_, index) =>
    Number(((from + index) * step).toPrecision(12)),
  );
  return { low: ticks[0]!, high: ticks.at(-1)!, ticks };
}

/**
 * Where everything goes at one size, in pixels. Text is not measured: `charWidth` is the average
 * glyph width of the axis font, which is enough to keep labels from colliding.
 */
export function kinChartLayout(
  view: KinChartView,
  size: { readonly width: number; readonly height: number; readonly charWidth?: number },
): KinChartLayout {
  const { width, height } = size;
  const charWidth = size.charWidth ?? 6;
  const scale = domain(view);
  const yLabels = scale.ticks.map((tick) => formatKinChartValue(view.unit, tick, "compact"));
  const left = Math.max(...yLabels.map((text) => text.length)) * charWidth + 8;
  const plot = { left, right: width - 6, top: 8, bottom: height - 20 };
  const plotWidth = Math.max(1, plot.right - plot.left);
  const plotHeight = Math.max(1, plot.bottom - plot.top);
  const toY = (value: number) =>
    round(plot.bottom - ((value - scale.low) / (scale.high - scale.low)) * plotHeight);

  const count = view.labels.length;
  const line = view.kind === "line";
  const band = plotWidth / count;
  const inset = 6;
  const spacing = line && count > 1 ? (plotWidth - inset * 2) / (count - 1) : band;
  const toX = (index: number) =>
    round(
      line && count > 1 ? plot.left + inset + spacing * index : plot.left + band * (index + 0.5),
    );

  // A category keeps its label under its own bar, cut to the room it has; dates thin out instead.
  const gap = 10;
  const room = view.dated
    ? AXIS_LABEL_CHARS
    : Math.max(MIN_LABEL_CHARS, Math.floor((spacing - gap) / charWidth));
  const short = view.labels.map((one) => {
    const chars = Array.from(one.short);
    return chars.length > room ? `${chars.slice(0, room - 1).join("")}…` : one.short;
  });
  const widest = Math.max(...short.map((text) => text.length)) * charWidth + gap;
  const every = Math.max(1, Math.ceil(widest / spacing));
  const xTicks = short.flatMap((text, index) => {
    const offset = view.dated ? count - 1 - index : index;
    if (offset % every !== 0) return [];
    const x = toX(index);
    const half = (text.length * charWidth) / 2;
    const anchor = x - half < 0 ? "start" : x + half > width ? "end" : "middle";
    return [
      {
        key: `x-${index}`,
        x: anchor === "start" ? 0 : anchor === "end" ? width : x,
        label: text,
        anchor,
      } as const,
    ];
  });

  const many = view.series.length > 1;
  const title = (series: KinChartSeriesView, index: number, value: number) =>
    `${view.labels[index]!.full}: ${many ? `${series.name} ` : ""}${formatKinChartValue(view.unit, value)}`;

  const bars: Array<KinChartLayout["bars"][number]> = [];
  if (!line) {
    const stacked = view.kind === "stacked_bar";
    const columns = stacked ? 1 : view.series.length;
    const gap = columns > 1 ? 2 : 0;
    const barWidth = Math.max(1, Math.min(40, (band * 0.72 - gap * (columns - 1)) / columns));
    const groupWidth = barWidth * columns + gap * (columns - 1);
    const floor = toY(0);
    for (let index = 0; index < count; index++) {
      const start = plot.left + band * (index + 0.5) - groupWidth / 2;
      let base = 0;
      view.series.forEach((series, column) => {
        const value = series.values[index] ?? null;
        if (value === null) return;
        const top = toY(stacked ? base + value : Math.max(value, 0));
        const bottom = stacked ? toY(base) : value < 0 ? toY(value) : floor;
        base += value;
        // A zero still leaves a mark, so it never reads as a missing value. Stacked segments
        // keep a hairline between them.
        const tall = Math.max(1.5, bottom - top - (stacked && base > value ? 1 : 0));
        bars.push({
          key: `${series.key}-${index}`,
          tone: series.tone,
          x: round(start + (stacked ? 0 : column * (barWidth + gap))),
          y: round(value < 0 ? top : Math.min(top, bottom - tall)),
          width: round(barWidth),
          height: round(tall),
          radius: stacked ? 0 : 2,
          title: title(series, index, value),
        });
      });
    }
  }

  const lines = !line
    ? []
    : view.series.map((series) => {
        const points = series.values.map((value, index) =>
          value === null ? null : { index, value, x: toX(index), y: toY(value) },
        );
        const path = points
          .flatMap((point, index) =>
            point === null
              ? []
              : [`${index === 0 || points[index - 1] === null ? "M" : "L"}${point.x} ${point.y}`],
          )
          .join("");
        const alone = (index: number) =>
          (points[index - 1] ?? null) === null && (points[index + 1] ?? null) === null;
        return {
          key: series.key,
          tone: series.tone,
          path,
          dots: points.flatMap((point) =>
            point !== null && (count <= DOTS_UP_TO || alone(point.index))
              ? [
                  {
                    key: `${series.key}-${point.index}`,
                    x: point.x,
                    y: point.y,
                    title: title(series, point.index, point.value),
                  },
                ]
              : [],
          ),
        };
      });

  return {
    width,
    height,
    plot,
    yTicks: scale.ticks.map((value, index) => ({ value, y: toY(value), label: yLabels[index]! })),
    zeroY: scale.low < 0 && scale.high > 0 ? toY(0) : null,
    xTicks,
    bars,
    lines,
  };
}
