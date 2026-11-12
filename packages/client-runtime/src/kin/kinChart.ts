import {
  KinChartCardState,
  type KinChartColor,
  type KinChartKind,
  type KinChartSpec,
  type KinChartUnit,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinSentences } from "./kinScreenState.ts";

/** One of the product's colours; `soft` is the same colour drawn lighter. */
export interface KinChartTone {
  readonly color: KinChartColor;
  readonly soft: boolean;
}

/** What a legend draws beside a name, so the key looks like the thing it names. */
export type KinChartMark = "line" | "dashed" | "box" | "dot";

export interface KinChartSeriesView {
  readonly key: string;
  readonly name: string;
  readonly tone: KinChartTone;
  /** The muted comparison: drawn behind, and dashed where it is a line. */
  readonly previous: boolean;
  readonly values: ReadonlyArray<number | null>;
}

export interface KinChartSliceView {
  readonly key: string;
  readonly name: string;
  readonly tone: KinChartTone;
  readonly value: number;
  /** "₹1,20,000 · 34%", as the legend and a tooltip say it. */
  readonly detail: string;
}

export interface KinChartScatterView {
  readonly xName: string;
  readonly yName: string;
  readonly xUnit: KinChartUnit;
  readonly series: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly tone: KinChartTone;
    readonly points: ReadonlyArray<{
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly label: string | null;
      readonly title: string;
    }>;
  }>;
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
  /** A colour per label, when one series of bars is coloured bar by bar. */
  readonly labelTones: ReadonlyArray<KinChartTone> | null;
  /** A pie's drawn slices: past twelve, the smallest are drawn together as one. */
  readonly slices: ReadonlyArray<KinChartSliceView>;
  /** What a donut says in its middle. */
  readonly total: string | null;
  readonly scatter: KinChartScatterView | null;
  readonly target: { readonly name: string; readonly value: number } | null;
  readonly valueLabels: boolean;
  /** Empty when a single series needs no key. */
  readonly legend: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly tone: KinChartTone;
    readonly mark: KinChartMark;
    readonly detail: string | null;
  }>;
  /** A pie's key is read as a list, one slice and its share per row. */
  readonly legendAsList: boolean;
  readonly table: {
    readonly columns: ReadonlyArray<{ readonly key: string; readonly name: string }>;
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
/** One whole unit of what a chart counts: a rupee in paise, or simply 1. */
export const kinChartWholeUnit = (unit: KinChartUnit) =>
  unit.kind === "money" ? 10 ** minorDigits(unit.currency) : 1;
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

// Strong colours first, red last so it is never a default by accident; then each one soft.
const COLORS = ["accent", "amber", "green", "purple", "grey", "red"] as const;
const PREVIOUS: KinChartTone = { color: "grey", soft: true };
const toneAt = (index: number): KinChartTone => ({
  color: COLORS[index % COLORS.length]!,
  soft: Math.floor(index / COLORS.length) % 2 === 1,
});
const tone = (color: KinChartColor | null | undefined, index: number): KinChartTone =>
  color === null || color === undefined ? toneAt(index) : { color, soft: false };

const KIND_NAMES: Record<KinChartKind, string> = {
  line: "Line chart",
  area: "Area chart",
  stacked_area: "Stacked area chart",
  bar: "Bar chart",
  stacked_bar: "Stacked bar chart",
  horizontal_bar: "Bar chart",
  stacked_horizontal_bar: "Stacked bar chart",
  pie: "Pie chart",
  donut: "Donut chart",
  radar: "Radar chart",
  scatter: "Scatter chart",
};
const MARKS: Record<KinChartKind, KinChartMark> = {
  line: "line",
  area: "box",
  stacked_area: "box",
  bar: "box",
  stacked_bar: "box",
  horizontal_bar: "box",
  stacked_horizontal_bar: "box",
  pie: "box",
  donut: "box",
  radar: "line",
  scatter: "dot",
};
// Kinds whose labels run in an order worth reading as "from the first to the last".
const ORDERED: ReadonlySet<KinChartKind> = new Set([
  "line",
  "area",
  "stacked_area",
  "bar",
  "stacked_bar",
]);
const SLICES = 12;

const share = (value: number, total: number) => {
  const percent = (value / total) * 100;
  return percent > 0 && percent < 0.1 ? "<0.1%" : `${trimmed(percent, 1)}%`;
};

const EMPTY = {
  labels: [],
  dated: false,
  series: [],
  labelTones: null,
  slices: [],
  total: null,
  scatter: null,
  legendAsList: false,
} as const;

function scatterView(spec: KinChartSpec, scatter: NonNullable<KinChartSpec["scatter"]>) {
  const many = scatter.series.length > 1;
  const points = scatter.series.flatMap((series) => series.points);
  const keep = (unit: KinChartUnit, values: ReadonlyArray<number | null>) =>
    values.some((value) => value !== null && value % kinChartWholeUnit(unit) !== 0);
  const keepX = keep(
    scatter.xUnit,
    points.map((point) => point.x),
  );
  const keepY = keep(
    spec.unit,
    points.map((point) => point.y),
  );
  const sayX = (value: number) => formatKinChartValue(scatter.xUnit, value, "full", keepX);
  const sayY = (value: number) => formatKinChartValue(spec.unit, value, "full", keepY);
  const series = scatter.series.map((one, index) => ({
    key: `series-${index}`,
    name: one.name,
    tone: tone(one.color, index),
    points: one.points.flatMap((point, at) => {
      if (point.x === null || point.y === null) return [];
      const name = point.label ?? (many ? `${one.name} ${at + 1}` : `Point ${at + 1}`);
      return [
        {
          key: `series-${index}-${at}`,
          x: point.x,
          y: point.y,
          label: point.label ?? null,
          name,
          title: `${name}: ${scatter.xName} ${sayX(point.x)}, ${scatter.yName} ${sayY(point.y)}`,
        },
      ];
    }),
  }));
  const range = (values: ReadonlyArray<number>, say: (value: number) => string) => {
    const low = Math.min(...values);
    const high = Math.max(...values);
    return low === high ? say(low) : `${say(low)} to ${say(high)}`;
  };
  return {
    scatter: { xName: scatter.xName, yName: scatter.yName, xUnit: scatter.xUnit, series },
    legend: many
      ? series.map(({ key, name, tone }) => ({
          key,
          name,
          tone,
          mark: "dot" as const,
          detail: null,
        }))
      : [],
    table: {
      columns: [
        ...(many ? [{ key: "group", name: "Group" }] : []),
        { key: "x", name: scatter.xName },
        { key: "y", name: scatter.yName },
      ],
      rows: series.flatMap((one) =>
        one.points.map((point) => ({
          key: point.key,
          label: point.name,
          cells: [...(many ? [one.name] : []), sayX(point.x), sayY(point.y)],
        })),
      ),
    },
    described: [
      `${scatter.yName} against ${scatter.xName}`,
      ...series.map((one) =>
        one.points.length === 0
          ? `${one.name}: no points`
          : `${one.name}: ${one.points.length} ${one.points.length === 1 ? "point" : "points"}, ${scatter.xName} ${range(
              one.points.map((point) => point.x),
              sayX,
            )}, ${scatter.yName} ${range(
              one.points.map((point) => point.y),
              sayY,
            )}`,
      ),
    ],
  };
}

/** A chart ready to draw, from a spec that already passed `kinChartProblem`. */
export function kinChartView(spec: KinChartSpec): KinChartView {
  const kind = spec.chart;
  const keepMinorFor = (values: ReadonlyArray<number | null>) =>
    values.some((value) => value !== null && value % kinChartWholeUnit(spec.unit) !== 0);
  const target = spec.target ?? null;
  const head = {
    kind,
    title: spec.title,
    caption: spec.caption,
    unit: spec.unit,
    target,
    valueLabels: spec.valueLabels === true,
  };
  const targetSaid = (keepMinor: boolean) =>
    target === null
      ? null
      : `${target.name}: ${formatKinChartValue(spec.unit, target.value, "full", keepMinor)}`;
  const summary = (parts: ReadonlyArray<string | null>) =>
    kinSentences([`${KIND_NAMES[kind]}: ${spec.title}`, ...parts, spec.caption]);

  if (spec.scatter !== undefined) {
    const { described, ...scatter } = scatterView(spec, spec.scatter);
    return {
      ...EMPTY,
      ...head,
      ...scatter,
      summary: summary([...described, targetSaid(false)]),
    };
  }

  const labels = spec.labels.map((text) => label(spec, text));
  const current = spec.series.map((series, index): KinChartSeriesView => ({
    key: `series-${index}`,
    name: series.name,
    tone: tone(series.color, index),
    previous: false,
    values: series.values,
  }));
  const previous: ReadonlyArray<KinChartSeriesView> =
    spec.comparison === null
      ? []
      : [
          {
            key: "previous",
            name: spec.comparison.name,
            tone:
              spec.comparison.color === undefined
                ? PREVIOUS
                : { color: spec.comparison.color, soft: false },
            previous: true,
            values: spec.comparison.values,
          },
        ];
  // People read the current period first, whatever is drawn first.
  const read = [...current, ...previous];
  const values = read.flatMap((series) => series.values);
  const keepMinor = keepMinorFor(target === null ? values : [...values, target.value]);
  const full = (value: number | null) =>
    value === null ? MISSING : formatKinChartValue(spec.unit, value, "full", keepMinor);
  const missing = values.filter((value) => value === null).length;
  const missingSaid =
    missing === 0 ? null : `${missing} ${missing === 1 ? "value is" : "values are"} missing`;

  if (kind === "pie" || kind === "donut") {
    const [series] = current;
    const total = series!.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const all = series!.values.flatMap((value, index) =>
      value === null ? [] : [{ index, value, name: labels[index]!.full }],
    );
    // Past twelve slices nobody can match a colour to a name, so the smallest are drawn as one.
    const kept =
      all.length <= SLICES
        ? all
        : [...all]
            .sort((a, b) => b.value - a.value)
            .slice(0, SLICES - 1)
            .sort((a, b) => a.index - b.index);
    const rest = all.length - kept.length;
    const detail = (value: number) => `${full(value)} · ${share(value, total)}`;
    const slices: ReadonlyArray<KinChartSliceView> = [
      ...kept.map((slice) => ({
        key: `slice-${slice.index}`,
        name: slice.name,
        tone: tone(spec.colors?.[slice.index], kept.indexOf(slice)),
        value: slice.value,
        detail: detail(slice.value),
      })),
      ...(rest === 0
        ? []
        : [kept.reduce((left, slice) => left - slice.value, total)].map((value) => ({
            key: "slice-rest",
            name: `${rest} others`,
            tone: PREVIOUS,
            value,
            detail: detail(value),
          }))),
    ];
    return {
      ...EMPTY,
      ...head,
      labels,
      series: current,
      slices,
      total: formatKinChartValue(spec.unit, total, "compact"),
      legend: slices.map(({ key, name, tone, detail }) => ({
        key,
        name,
        tone,
        mark: "box",
        detail,
      })),
      legendAsList: true,
      table: {
        columns: [
          { key: "value", name: series!.name },
          { key: "share", name: "Share" },
        ],
        rows: [
          ...labels.map((one, index) => {
            const value = series!.values[index] ?? null;
            return {
              key: `row-${index}`,
              label: one.full,
              cells: [full(value), value === null ? MISSING : share(value, total)],
            };
          }),
          { key: "row-total", label: "Total", cells: [full(total), "100%"] },
        ],
      },
      summary: summary([
        `Total ${full(total)}`,
        ...slices.map((slice) => `${slice.name}: ${slice.detail.replace(" · ", ", ")}`),
        missingSaid,
      ]),
    };
  }

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
    const span = ORDERED.has(kind) ? `${say(first)} to ${say(points.at(-1)!)}; ` : "";
    return `${series.name}: ${span}highest ${say(highest)}, lowest ${say(lowest)}`;
  });
  const colored = spec.colors !== undefined && read.length === 1;

  return {
    ...EMPTY,
    ...head,
    labels,
    dated: spec.labelType !== "category",
    series: [...previous, ...current],
    labelTones: colored ? spec.colors.map((color) => tone(color, 0)) : null,
    legend:
      read.length > 1
        ? read.map(({ key, name, tone, previous }) => ({
            key,
            name,
            tone,
            mark: previous && MARKS[kind] === "line" ? "dashed" : MARKS[kind],
            detail: null,
          }))
        : [],
    table: {
      columns: read.map(({ key, name }) => ({ key, name })),
      rows: labels.map((one, index) => ({
        key: `row-${index}`,
        label: one.full,
        cells: read.map((series) => full(series.values[index] ?? null)),
      })),
    },
    summary: summary([...described, targetSaid(keepMinor), missingSaid]),
  };
}

const decode = Schema.decodeUnknownOption(KinChartCardState);

/** A chat card's chart, or null when this build can't read it. */
export function kinChartCardView(widget: KinWidget): KinChartView | null {
  const state = decode(widget.state);
  return Option.isSome(state) ? kinChartView(state.value) : null;
}
