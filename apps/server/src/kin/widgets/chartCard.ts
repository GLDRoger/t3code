import {
  KinChartColor,
  KinChartKind,
  KinChartLabelType,
  KinChartScatter,
  KinChartSeries,
  KinChartTarget,
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
  labels: Schema.optional(Schema.Array(Schema.String)),
  labelType: Schema.optional(KinChartLabelType),
  series: Schema.optional(Schema.Array(KinChartSeries)),
  comparison: Schema.optional(KinChartSeries),
  caption: Schema.optional(Schema.String),
  colors: Schema.optional(Schema.Array(Schema.NullOr(KinChartColor))),
  target: Schema.optional(KinChartTarget),
  valueLabels: Schema.optional(Schema.Boolean),
  scatter: Schema.optional(
    Schema.Struct({
      ...KinChartScatter.fields,
      xUnit: Schema.optional(KinChartUnit),
    }),
  ),
});
export type ChartInput = typeof ChartInput.Type;
export const ChartResult = Schema.Struct({
  widgetId: KinTrimmedText,
  messageId: KinTrimmedText,
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const currencies: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));
const line = (text: string) => text.replace(/\s+/g, " ").trim();
// JSON has no negative zero, and a chart has no use for one.
const plain = (value: number | null) => (value === null ? null : value + 0);
const series = (one: KinChartSeries): KinChartSeries => ({
  name: line(one.name),
  values: one.values.map(plain),
  ...(one.color === undefined ? {} : { color: one.color }),
});
const scatter = (input: NonNullable<ChartInput["scatter"]>): KinChartScatter => ({
  xName: line(input.xName),
  yName: line(input.yName),
  xUnit: input.xUnit ?? { kind: "count" },
  series: input.series.map((one) => ({
    name: line(one.name),
    ...(one.color === undefined ? {} : { color: one.color }),
    points: one.points.map((point) => ({
      x: plain(point.x),
      y: plain(point.y),
      ...(point.label === undefined ? {} : { label: line(point.label) }),
    })),
  })),
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
    labels: (input.labels ?? []).map(line),
    series: (input.series ?? []).map(series),
    comparison: input.comparison === undefined ? null : series(input.comparison),
    ...(input.colors === undefined ? {} : { colors: input.colors }),
    ...(input.target === undefined
      ? {}
      : { target: { name: line(input.target.name), value: input.target.value + 0 } }),
    ...(input.valueLabels === true ? { valueLabels: true } : {}),
    ...(input.scatter === undefined ? {} : { scatter: scatter(input.scatter) }),
  };
  const problem = kinChartProblem(state);
  if (problem !== null) return yield* invalid(problem);
  for (const unit of [state.unit, ...(state.scatter === undefined ? [] : [state.scatter.xUnit])])
    if (unit.kind === "money" && !currencies.has(unit.currency))
      return yield* invalid(
        `"${unit.currency}" is not a currency code: use the ISO 4217 code, such as "INR" or "USD".`,
      );
  return state;
});
