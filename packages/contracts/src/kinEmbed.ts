import * as Schema from "effect/Schema";
import { KinTrimmedText, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChartCardState } from "./kinChart.ts";

export const KinEmbed = Schema.Union([
  Schema.TaggedStruct("chart", { chart: KinChartCardState }),
  Schema.TaggedStruct("visual", {
    title: KinTrimmedText,
    attachmentId: TrimmedNonEmptyString,
    height: PositiveInt,
    heights: Schema.optional(
      Schema.Array(Schema.Tuple([PositiveInt, PositiveInt])).check(Schema.isMaxLength(24)),
    ),
    sensitive: Schema.optional(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("broken", { message: KinTrimmedText }),
]);
export type KinEmbed = typeof KinEmbed.Type;

export const KIN_MESSAGE_FIGURES_MAX = 4;
export const KIN_MESSAGE_PAGES_MAX = 2;
export const KIN_FIGURE_SCHEME = "kin-figure:";
