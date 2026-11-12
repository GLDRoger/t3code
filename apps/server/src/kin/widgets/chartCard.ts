import {
  KinChartKind,
  KinChartLabelType,
  KinChartSeries,
  KinChartUnit,
  KinChatError,
  KinTrimmedText,
  kinChartProblem,
  type KinChartCardState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * What `kin_chart` takes. Only shapes are checked here: `chartCardState` applies every limit, so
 * a refusal can say how to fix the call.
 */
export const ChartInput = Schema.Struct({
  chart: KinChartKind,
  title: Schema.String,
  unit: KinChartUnit,
  labels: Schema.Array(Schema.String),
  labelType: Schema.optional(KinChartLabelType),
  series: Schema.Array(KinChartSeries),
  comparison: Schema.optional(KinChartSeries),
  caption: Schema.optional(Schema.String),
});
export type ChartInput = typeof ChartInput.Type;
export const ChartResult = Schema.Struct({
  widgetId: KinTrimmedText,
  messageId: KinTrimmedText,
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const currencies: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));
const line = (text: string) => text.replace(/\s+/g, " ").trim();
const series = (one: KinChartSeries): KinChartSeries => ({
  name: line(one.name),
  // JSON has no negative zero, and a chart has no use for one.
  values: one.values.map((value) => (value === null ? null : value + 0)),
});

/** The stored card, or a refusal that tells the agent what to change. */
export const chartCardState = Effect.fn("KinChartCard.state")(function* (input: ChartInput) {
  const title = line(input.title);
  if (title === "") return yield* invalid("A chart needs a title that says what it shows.");
  const caption = input.caption === undefined ? "" : line(input.caption);
  const state: KinChartCardState = {
    chart: input.chart,
    title,
    caption: caption === "" ? null : caption,
    unit: input.unit,
    labelType: input.labelType ?? "category",
    labels: input.labels.map(line),
    series: input.series.map(series),
    comparison: input.comparison === undefined ? null : series(input.comparison),
  };
  const problem = kinChartProblem(state);
  if (problem !== null) return yield* invalid(problem);
  if (state.unit.kind === "money" && !currencies.has(state.unit.currency))
    return yield* invalid(
      `"${state.unit.currency}" is not a currency code: use the ISO 4217 code, such as "INR" or "USD".`,
    );
  return state;
});
