import { assert, expect, it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { Tool } from "effect/ai";
import { advertisedJsonSchema } from "../../mcp/advertisedJsonSchema.ts";
import { inputPropertyPaths } from "../mcp/inputPropertyPaths.testHelper.ts";
import { ImportHeader } from "./importFormat.ts";
import { DefineInput } from "./leadMoney.ts";
import { KinDocsToolkit } from "./mcp/docTools.ts";
import { KinWorkToolkit } from "./mcp/tools.ts";

// Checked by a pattern, which JSON Schema output drops; their descriptions or ids say the shape.
const FORMATTED = new Set([
  "sourceEventId",
  "key",
  "keys",
  "besides",
  "list",
  "due",
  "date",
  "finishedOn",
  "startsOn",
  "renewsOn",
  "currency",
  "repo",
  "repos",
  "doc",
  "links",
]);

/** Each string property's name whose validated schema states no bound and no allowed values. */
const unbounded = (schema: unknown, name = ""): ReadonlyArray<string> => {
  if (Array.isArray(schema)) return schema.flatMap((item) => unbounded(item, name));
  if (!Predicate.isObject(schema)) return [];
  const own =
    schema.type === "string" && schema.maxLength === undefined && schema.enum === undefined
      ? [name]
      : [];
  const properties = Predicate.isObject(schema.properties)
    ? Object.entries(schema.properties).flatMap(([key, value]) => unbounded(value, key))
    : [];
  return [
    ...own,
    ...properties,
    ...unbounded(schema.items, name),
    ...unbounded(schema.anyOf, name),
  ];
};

it("the batch-write tools validate every free-text field's bound", () => {
  const tools = {
    record_create: KinWorkToolkit.tools.record_create,
    record_update: KinWorkToolkit.tools.record_update,
    record_assign: KinWorkToolkit.tools.record_assign,
    record_hand_back: KinWorkToolkit.tools.record_hand_back,
    doc_create: KinDocsToolkit.tools.doc_create,
  };
  for (const [name, tool] of Object.entries(tools))
    assert.deepStrictEqual(
      unbounded(Tool.getJsonSchema(tool)).filter((field) => !FORMATTED.has(field)),
      [],
      name,
    );
});

it("list_define takes number and yes or no fields; imports and unknown types stay refused", () => {
  const define = Schema.is(DefineInput);
  const importHeader = Schema.is(ImportHeader);
  const accepted = (type: string) => {
    const fields = [{ label: "Count", type }];
    return [
      define({ sourceEventId: "ask-event", name: "Stock", fields }),
      importHeader({
        format: "kin-import",
        version: 1,
        batch: "stock",
        lists: [{ list: "stock", fields }],
      }),
    ];
  };
  assert.deepStrictEqual(accepted("text"), [true, true]);
  assert.deepStrictEqual(accepted("unknown"), [false, false]);
  for (const type of ["number", "yesno"])
    assert.deepStrictEqual(accepted(type), [true, false], type);
});

it("advertises every list definition key except the filled-in source event, with a single field type enum", () => {
  const tool = KinWorkToolkit.tools.list_define;
  const advertised = advertisedJsonSchema(tool, { kin: true });
  assert.deepStrictEqual(
    inputPropertyPaths(advertised),
    inputPropertyPaths(Tool.getJsonSchema(tool)).difference(new Set(["sourceEventId"])),
  );
  expect(advertised.properties).toHaveProperty("fields.items.properties.type", {
    type: "string",
    enum: ["text", "choice", "date", "person", "link", "money", "file", "number", "yesno"],
  });
});

it("advertises record write keys except the filled-in source event and the tax aliases", () => {
  const { record_create, record_update } = KinWorkToolkit.tools;
  for (const tool of [record_create, record_update]) {
    const raw = Tool.getJsonSchema(tool);
    const advertised = advertisedJsonSchema(tool, { kin: true });
    const row = tool.name === "record_create" ? "records[]." : "";
    const hidden = new Set(["sourceEventId", `${row}taxNumber`, `${row}taxPlace`]);
    const accepted = inputPropertyPaths(raw);
    assert.isTrue(hidden.isSubsetOf(accepted), tool.name);
    assert.deepStrictEqual(inputPropertyPaths(advertised), accepted.difference(hidden), tool.name);
    const prefix = tool.name === "record_create" ? "records.items.properties." : "";
    expect(advertised.properties).toHaveProperty(`${prefix}confirmed`, { type: "boolean" });
    expect(advertised.properties).toHaveProperty(`${prefix}due.description`, expect.any(String));
  }
});
