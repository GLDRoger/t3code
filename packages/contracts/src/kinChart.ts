import * as Schema from "effect/Schema";

import { KinTrimmedText } from "./kinChat.ts";

const KIN_CHART_MAX_POINTS = 24;
const KIN_CHART_MAX_SERIES = 4;
const KIN_CHART_MAX_LABEL = 24;
const KIN_CHART_MAX_NAME = 32;
const KIN_CHART_MAX_TITLE = 80;
const KIN_CHART_MAX_CAPTION = 140;
/** Well inside the exact integer range of a double, so minor units never round. */
const KIN_CHART_MAX_VALUE = 1e15;

export const KinChartKind = Schema.Literals(["line", "bar", "stacked_bar"]);
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

export const KinChartSeries = Schema.Struct({
  name: Schema.String,
  // One per label; null where there is no value.
  values: Schema.Array(Schema.NullOr(Schema.Finite)),
});
export type KinChartSeries = typeof KinChartSeries.Type;

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

/**
 * Why a chart can't be drawn, said so its author can fix it, or null when it can. The one rule
 * set for the tool that posts a chart, the stored card, and the clients that draw it.
 */
export function kinChartProblem(chart: KinChartSpec): string | null {
  if (chars(chart.title) > KIN_CHART_MAX_TITLE)
    return `The title is too long: keep it to ${KIN_CHART_MAX_TITLE} characters.`;
  if (chart.caption !== null && chars(chart.caption) > KIN_CHART_MAX_CAPTION)
    return `The caption is too long: keep it to one line of ${KIN_CHART_MAX_CAPTION} characters and say the rest in your reply.`;
  if (chart.unit.kind === "money" && !/^[A-Z]{3}$/.test(chart.unit.currency))
    return 'currency must be a three-letter ISO 4217 code in capitals, such as "INR" or "USD".';

  const { labels } = chart;
  if (labels.length === 0) return "A chart needs at least one label.";
  if (labels.length > KIN_CHART_MAX_POINTS)
    return `Too many points: ${labels.length} labels. A chart shows at most ${KIN_CHART_MAX_POINTS}: group them into longer periods (weeks instead of days) or keep the latest ${KIN_CHART_MAX_POINTS}.`;
  for (const label of labels) {
    if (blank(label) || label !== label.trim())
      return "Every label needs text, without spaces around it.";
    if (chars(label) > KIN_CHART_MAX_LABEL)
      return `The label "${label}" is too long: keep each label to ${KIN_CHART_MAX_LABEL} characters.`;
  }
  if (new Set(labels).size !== labels.length)
    return "Two labels are the same: each point needs its own label.";
  if (chart.labelType === "day" && !labels.every(realDay))
    return 'With labelType "day" every label is a real date written YYYY-MM-DD, such as "2026-11-03". Use labelType "category" for any other label.';
  if (chart.labelType === "month" && !labels.every((label) => MONTH.test(label)))
    return 'With labelType "month" every label is written YYYY-MM, such as "2026-11". Use labelType "category" for any other label.';
  if (
    chart.labelType !== "category" &&
    labels.some((label, index) => index > 0 && label <= labels[index - 1]!)
  )
    return "Dates go oldest first, each one later than the one before.";

  const { series, comparison } = chart;
  if (series.length === 0) return "A chart needs at least one series.";
  if (series.length > KIN_CHART_MAX_SERIES)
    return `Too many series: ${series.length}. A chart shows at most ${KIN_CHART_MAX_SERIES}: keep the largest and add the rest together as "Other".`;
  if (comparison !== null && series.length !== 1)
    return "comparison is one series against its previous period: send exactly one series with it, or put every series in series and leave comparison out.";
  if (chart.chart === "stacked_bar" && comparison !== null)
    return 'A stacked bar can\'t carry a comparison: use chart "bar".';
  if (chart.chart === "stacked_bar" && series.length < 2)
    return 'A stacked bar needs two or more series that add up to a total: use chart "bar" for one.';

  const drawn = comparison === null ? series : [...series, comparison];
  const names = new Set<string>();
  let values = 0;
  for (const one of drawn) {
    if (blank(one.name) || one.name !== one.name.trim()) return "Every series needs a name.";
    if (chars(one.name) > KIN_CHART_MAX_NAME)
      return `The series name "${one.name}" is too long: keep it to ${KIN_CHART_MAX_NAME} characters.`;
    if (names.has(one.name)) return `Two series are named "${one.name}": give each its own name.`;
    names.add(one.name);
    if (one.values.length !== labels.length)
      return `"${one.name}" has ${one.values.length} values for ${labels.length} labels: send one value per label, in order, with null where there is none.`;
    for (const value of one.values) {
      if (value === null) continue;
      values++;
      if (Math.abs(value) > KIN_CHART_MAX_VALUE) return `The value ${value} is too large to draw.`;
      if (chart.unit.kind === "money" && !Number.isInteger(value))
        return `Money is sent in whole minor units, never with decimals: ${value} is not a whole number. For 1,299.50 send 129950.`;
      if (chart.chart === "stacked_bar" && value < 0)
        return 'A stacked bar can\'t show negative values: use chart "bar".';
    }
  }
  if (values === 0) return "Every value is missing, so there is nothing to draw.";
  return null;
}

export const KinChartCardState = KinChartFields.check(
  Schema.makeFilter((chart: KinChartSpec) => kinChartProblem(chart) === null, {
    expected: "a chart every client can draw",
  }),
);
export type KinChartCardState = typeof KinChartCardState.Type;
