import * as Schema from "effect/Schema";

import { KinTrimmedText } from "./kinChat.ts";

// Every number below bounds what a chat row stores and a phone draws. None is a taste limit.
/** A year of days fits; past this a chart is a table. */
const KIN_CHART_MAX_POINTS = 500;
/** The palette has twelve tones that can be told apart. */
const KIN_CHART_MAX_SERIES = 12;
/** Labels times series: each value is a stored number and, for bars, a drawn shape. */
const KIN_CHART_MAX_VALUES = 3000;
const KIN_CHART_MAX_SCATTER_POINTS = 1000;
/** Axis names sit around a circle; more than this and none can be read. */
const KIN_CHART_MAX_RADAR_AXES = 24;
/** A horizontal chart grows a row per label, and a card that tall is no longer a chat message. */
const KIN_CHART_MAX_ROWS = 60;
const KIN_CHART_MAX_ROW_BARS = 240;
const KIN_CHART_MAX_LABEL = 80;
const KIN_CHART_MAX_NAME = 60;
const KIN_CHART_MAX_TITLE = 120;
const KIN_CHART_MAX_CAPTION = 280;
/** Well inside the exact integer range of a double, so minor units never round. */
const KIN_CHART_MAX_VALUE = 1e15;

export const KinChartKind = Schema.Literals([
  "line",
  "area",
  "stacked_area",
  "bar",
  "stacked_bar",
  "horizontal_bar",
  "stacked_horizontal_bar",
  "pie",
  "donut",
  "radar",
  "scatter",
]);
export type KinChartKind = typeof KinChartKind.Type;

/** Money values are whole minor units of `currency` (paise, cents); clients do the formatting. */
export const KinChartUnit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("count") }),
  Schema.Struct({ kind: Schema.Literal("percent") }),
  Schema.Struct({ kind: Schema.Literal("money"), currency: Schema.String }),
]);
export type KinChartUnit = typeof KinChartUnit.Type;

/** `day` labels are `YYYY-MM-DD` and `month` labels `YYYY-MM`, oldest first. */
export const KinChartLabelType = Schema.Literals(["category", "day", "month"]);
export type KinChartLabelType = typeof KinChartLabelType.Type;

/** The product's own colours by name, so a chart follows every theme. `accent` is the app's. */
export const KinChartColor = Schema.Literals(["accent", "green", "amber", "red", "purple", "grey"]);
export type KinChartColor = typeof KinChartColor.Type;

export const KinChartSeries = Schema.Struct({
  name: Schema.String,
  // One per label; null where there is no value.
  values: Schema.Array(Schema.NullOr(Schema.Finite)),
  color: Schema.optional(KinChartColor),
});
export type KinChartSeries = typeof KinChartSeries.Type;

export const KinChartTarget = Schema.Struct({ name: Schema.String, value: Schema.Finite });
export type KinChartTarget = typeof KinChartTarget.Type;

/** A scatter's points. `unit` on the chart is the y values' unit; `xUnit` is the x values'. */
export const KinChartScatter = Schema.Struct({
  xName: Schema.String,
  yName: Schema.String,
  xUnit: KinChartUnit,
  series: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      color: Schema.optional(KinChartColor),
      points: Schema.Array(
        Schema.Struct({
          // Null is accepted only so the refusal can say what to do about it.
          x: Schema.NullOr(Schema.Finite),
          y: Schema.NullOr(Schema.Finite),
          label: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
export type KinChartScatter = typeof KinChartScatter.Type;

const KinChartFields = Schema.Struct({
  chart: KinChartKind,
  title: KinTrimmedText,
  caption: Schema.NullOr(KinTrimmedText),
  unit: KinChartUnit,
  labelType: KinChartLabelType,
  labels: Schema.Array(Schema.String),
  series: Schema.Array(KinChartSeries),
  // The same series one period earlier, drawn muted behind the single current one.
  comparison: Schema.NullOr(KinChartSeries),
  // Everything from here was added after charts were first stored, so it stays optional.
  /** One per label: a pie's slices, or the bars of a single series. Null keeps the default. */
  colors: Schema.optional(Schema.Array(Schema.NullOr(KinChartColor))),
  target: Schema.optional(KinChartTarget),
  valueLabels: Schema.optional(Schema.Boolean),
  scatter: Schema.optional(KinChartScatter),
});
export type KinChartSpec = typeof KinChartFields.Type;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const realDay = (label: string) => {
  const match = DAY.exec(label);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
};

const blank = (text: string) => text.trim() === "" || text.includes("\u0000");
const chars = (text: string) => Array.from(text).length;
const unnamed = (name: string) => blank(name) || name !== name.trim();

const currencyProblem = (unit: KinChartUnit) =>
  unit.kind === "money" && !/^[A-Z]{3}$/.test(unit.currency)
    ? 'currency must be a three-letter ISO 4217 code in capitals, such as "INR" or "USD".'
    : null;

const valueProblem = (unit: KinChartUnit, value: number) =>
  Math.abs(value) > KIN_CHART_MAX_VALUE
    ? `The value ${value} is too large to draw.`
    : unit.kind === "money" && !Number.isInteger(value)
      ? `Money is sent in whole minor units, never with decimals: ${value} is not a whole number. For 1,299.50 send 129950.`
      : null;

const nameProblem = (what: string, name: string, taken: Set<string>) => {
  if (unnamed(name)) return `Every ${what} needs a name.`;
  if (chars(name) > KIN_CHART_MAX_NAME)
    return `The ${what} name "${name}" is too long: keep it to ${KIN_CHART_MAX_NAME} characters.`;
  if (taken.has(name)) return `Two ${what} are named "${name}": give each its own name.`;
  taken.add(name);
  return null;
};

function scatterProblem(chart: KinChartSpec): string | null {
  const { scatter } = chart;
  if (scatter === undefined)
    return 'A scatter takes its points in scatter: {xName, yName, series: [{name, points: [{x, y}]}]}. For values against labels use chart "line" or "bar".';
  if (chart.labels.length > 0 || chart.series.length > 0 || chart.comparison !== null)
    return "A scatter draws only the points in scatter.series: leave labels, series and comparison out.";
  if (chart.colors !== undefined)
    return "colors goes with labels, and a scatter has none: set color on each of scatter.series.";
  for (const name of [scatter.xName, scatter.yName])
    if (unnamed(name) || chars(name) > KIN_CHART_MAX_NAME)
      return `A scatter says what each axis measures: give xName and yName, each at most ${KIN_CHART_MAX_NAME} characters.`;
  const currency = currencyProblem(scatter.xUnit);
  if (currency !== null) return currency;
  if (scatter.series.length === 0) return "A scatter needs at least one series of points.";
  if (scatter.series.length > KIN_CHART_MAX_SERIES)
    return `Too many series: ${scatter.series.length}. A chart tells at most ${KIN_CHART_MAX_SERIES} colours apart: merge the smallest groups.`;
  const names = new Set<string>();
  let points = 0;
  for (const series of scatter.series) {
    const name = nameProblem("series", series.name, names);
    if (name !== null) return name;
    for (const point of series.points) {
      points++;
      if (point.x === null || point.y === null)
        return "A scatter can't place a point without both x and y: leave that point out.";
      const value = valueProblem(scatter.xUnit, point.x) ?? valueProblem(chart.unit, point.y);
      if (value !== null) return value;
      if (point.label === undefined) continue;
      if (unnamed(point.label) || chars(point.label) > KIN_CHART_MAX_LABEL)
        return `A point's label needs text of at most ${KIN_CHART_MAX_LABEL} characters, or leave label out.`;
    }
  }
  if (points === 0) return "A scatter needs at least one point.";
  if (points > KIN_CHART_MAX_SCATTER_POINTS)
    return `Too many points: ${points}. A scatter draws at most ${KIN_CHART_MAX_SCATTER_POINTS}: sample them, or group them and chart the groups.`;
  return null;
}

/**
 * Why a chart can't be drawn, said so its author can fix it, or null when it can. The one rule
 * set for the tool that posts a chart, the stored card, and the clients that draw it.
 */
export function kinChartProblem(chart: KinChartSpec): string | null {
  if (chars(chart.title) > KIN_CHART_MAX_TITLE)
    return `The title is too long: keep it to ${KIN_CHART_MAX_TITLE} characters.`;
  if (chart.caption !== null && chars(chart.caption) > KIN_CHART_MAX_CAPTION)
    return `The caption is too long: keep it to ${KIN_CHART_MAX_CAPTION} characters and say the rest in your reply.`;
  const currency = currencyProblem(chart.unit);
  if (currency !== null) return currency;

  const kind = chart.chart;
  const round = kind === "pie" || kind === "donut";
  if (chart.target !== undefined) {
    if (round)
      return 'A pie has no value axis to mark a target on: leave target out, or use chart "bar".';
    if (unnamed(chart.target.name) || chars(chart.target.name) > KIN_CHART_MAX_NAME)
      return `target needs a short name, such as "Goal", of at most ${KIN_CHART_MAX_NAME} characters.`;
    const value = valueProblem(chart.unit, chart.target.value);
    if (value !== null) return value;
    if (kind === "radar" && chart.target.value < 0)
      return "A radar starts every axis at zero, so its target can't be negative.";
  }
  if (kind === "scatter") return scatterProblem(chart);
  if (chart.scatter !== undefined)
    return 'scatter holds x/y points and goes only with chart "scatter": leave it out, or change chart.';

  const { labels } = chart;
  if (labels.length === 0) return "A chart needs at least one label.";
  if (labels.length > KIN_CHART_MAX_POINTS)
    return `Too many points: ${labels.length} labels. A chart shows at most ${KIN_CHART_MAX_POINTS}: group them into longer periods (weeks instead of days) or keep the latest ${KIN_CHART_MAX_POINTS}.`;
  for (const label of labels) {
    if (unnamed(label)) return "Every label needs text, without spaces around it.";
    if (chars(label) > KIN_CHART_MAX_LABEL)
      return `The label "${label}" is too long: keep each label to ${KIN_CHART_MAX_LABEL} characters.`;
  }
  if (chart.labelType === "day" && !labels.every(realDay))
    return 'With labelType "day" every label is a real date written YYYY-MM-DD, such as "2026-11-03". Use labelType "category" for any other label.';
  if (chart.labelType === "month" && !labels.every((label) => MONTH.test(label)))
    return 'With labelType "month" every label is written YYYY-MM, such as "2026-11". Use labelType "category" for any other label.';
  if (
    chart.labelType !== "category" &&
    labels.some((label, index) => index > 0 && label <= labels[index - 1]!)
  )
    return "Dates go oldest first, each one later than the one before.";
  if (kind === "radar" && labels.length < 3)
    return 'A radar needs three or more axes, one per label: use chart "bar" for fewer.';
  if (kind === "radar" && labels.length > KIN_CHART_MAX_RADAR_AXES)
    return `Too many axes: ${labels.length}. A radar shows at most ${KIN_CHART_MAX_RADAR_AXES}: use chart "horizontal_bar" for a long list.`;

  const { series, comparison } = chart;
  if (series.length === 0) return "A chart needs at least one series.";
  if (series.length > KIN_CHART_MAX_SERIES)
    return `Too many series: ${series.length}. A chart tells at most ${KIN_CHART_MAX_SERIES} colours apart: keep the largest and add the rest together as "Other".`;
  if (round && series.length !== 1)
    return 'A pie shows one series as shares of its total: send one series with a value per slice, or use chart "stacked_bar" to compare several.';
  if (comparison !== null && series.length !== 1)
    return 'comparison is one series against its previous period: send exactly one series with it, or put every series in series and give the earlier ones color "grey".';
  if (comparison !== null && (round || kind.startsWith("stacked")))
    return `A ${round ? "pie" : "stacked chart"} can't carry a comparison: use chart "bar" or "line".`;
  const drawn = comparison === null ? series : [...series, comparison];
  if (labels.length * drawn.length > KIN_CHART_MAX_VALUES)
    return `Too much to draw: ${labels.length} labels for ${drawn.length} series. Keep labels times series to ${KIN_CHART_MAX_VALUES}: use longer periods or fewer series.`;
  if (kind === "horizontal_bar" || kind === "stacked_horizontal_bar") {
    if (labels.length > KIN_CHART_MAX_ROWS)
      return `Too many rows: ${labels.length} labels. A horizontal chart shows at most ${KIN_CHART_MAX_ROWS}: keep the largest and add the rest together as "Other", or use chart "bar", which scrolls sideways.`;
    if (kind === "horizontal_bar" && labels.length * drawn.length > KIN_CHART_MAX_ROW_BARS)
      return `Too many bars: ${labels.length} labels for ${drawn.length} series. Side by side, a horizontal chart shows at most ${KIN_CHART_MAX_ROW_BARS}: use chart "stacked_horizontal_bar" or fewer series.`;
  }
  if (chart.colors !== undefined) {
    const bars = kind === "bar" || kind === "horizontal_bar";
    if (!(round || (bars && drawn.length === 1)))
      return "colors gives each label its own colour, which suits a pie or one series of bars: here set color on each series instead.";
    if (chart.colors.length !== labels.length)
      return `colors has ${chart.colors.length} entries for ${labels.length} labels: send one per label, with null to keep the default.`;
  }

  const names = new Set<string>();
  let values = 0;
  let total = 0;
  for (const one of drawn) {
    const name = nameProblem("series", one.name, names);
    if (name !== null) return name;
    if (one.values.length !== labels.length)
      return `"${one.name}" has ${one.values.length} values for ${labels.length} labels: send one value per label, in order, with null where there is none.`;
    for (const value of one.values) {
      if (value === null) continue;
      values++;
      total += value;
      const problem = valueProblem(chart.unit, value);
      if (problem !== null) return problem;
      if (value >= 0) continue;
      if (round)
        return 'A pie can\'t show a negative value, since a slice is a share of the total: use chart "bar".';
      if (kind === "radar")
        return 'A radar can\'t show a negative value, since every axis starts at zero: use chart "bar".';
      if (kind === "stacked_area")
        return 'A stacked area can\'t show negative values: use chart "stacked_bar" or "line".';
    }
  }
  if (values === 0) return "Every value is missing, so there is nothing to draw.";
  if (round && total === 0)
    return "A pie needs at least one value above zero: with nothing to share out, say it in text.";
  return null;
}

export const KinChartCardState = KinChartFields.check(
  Schema.makeFilter((chart: KinChartSpec) => kinChartProblem(chart) === null, {
    expected: "a chart every client can draw",
  }),
);
export type KinChartCardState = typeof KinChartCardState.Type;
