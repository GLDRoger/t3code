import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import {
  AcceptedUnadvertisedArguments,
  AdvertisedDescriptions,
  advertisedJsonSchema,
} from "./advertisedJsonSchema.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("advertises only string enum values, which Gemini requires", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set));

  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});

it("keeps the annotated core descriptions and advertises the rest as bare shapes", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      records: Schema.Array(
        Schema.Struct({
          shown: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
          bare: Schema.Struct({
            label: Schema.String.check(Schema.isMinLength(2)).annotate({ description: "Label." }),
            kind: Schema.Literals(["first", "second"]),
          }).annotate({ description: "Nested." }),
          due: Schema.optional(Schema.NullOr(Schema.String).annotate({ description: "Due date." })),
          count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2), Schema.isLessThanOrEqualTo(8)),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    }),
  }).annotate(AdvertisedDescriptions, [
    { path: ["properties", "records", "items"], keys: ["shown", "due", "count"] },
  ]);

  expect(advertisedJsonSchema(tool, { kin: true })).toEqual({
    type: "object",
    properties: {
      records: {
        type: "array",
        items: {
          type: "object",
          properties: {
            shown: { type: "string" },
            due: { type: "string", description: "Due date." },
            count: { type: "integer" },
            bare: {
              type: "object",
              properties: {
                label: { type: "string" },
                kind: { type: "string", enum: ["first", "second"] },
              },
              required: ["label", "kind"],
            },
          },
          required: ["shown", "bare", "count"],
        },
      },
    },
    required: ["records"],
  });
});

it("retains selected descriptions and advertises the remaining nested field shapes", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      title: Schema.String.annotate({ description: "Keep this text verbatim." }),
      rows: Schema.Array(
        Schema.Struct({
          description: Schema.String.annotate({ description: "A row's own text." }),
          score: Schema.Int.check(Schema.isGreaterThan(0)),
          color: Schema.optional(Schema.Literals(["green", "red"])),
        }),
      ).annotate({ description: "An array of rows." }),
    }),
  }).annotate(AdvertisedDescriptions, [{ path: [], keys: ["title"] }]);

  expect(advertisedJsonSchema(tool, { kin: true }).properties).toEqual({
    title: { type: "string", description: "Keep this text verbatim." },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          score: { type: "integer" },
          color: { type: "string", enum: ["green", "red"] },
        },
        required: ["description", "score"],
      },
    },
  });
  expect(Tool.getJsonSchema(tool).properties).toHaveProperty(
    "rows.description",
    "An array of rows.",
  );
});

it("omits selected arguments from the advertised properties and required keys", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      legacy: Schema.String,
      records: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          legacy: Schema.Int,
          extra: Schema.optional(Schema.String),
        }),
      ),
    }),
  });
  const annotated = tool.annotate(AcceptedUnadvertisedArguments, [
    "legacy",
    "records[].legacy",
    "records[].extra",
  ]);
  const properties = {
    records: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
  };

  expect(advertisedJsonSchema(annotated)).toEqual({
    type: "object",
    properties,
    required: ["records"],
  });
  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      legacy: { type: "string" },
      records: {
        ...properties.records,
        items: {
          ...properties.records.items,
          properties: {
            title: { type: "string" },
            legacy: { type: "integer" },
            extra: { type: "string" },
          },
          required: ["title", "legacy"],
        },
      },
    },
    required: ["legacy", "records"],
  });
});
