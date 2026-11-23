import { assert, it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { advertisedJsonSchema } from "../../mcp/advertisedJsonSchema.ts";
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

/** Each string property's name whose advertised schema states no bound and no allowed values. */
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

it("the batch-write tools advertise every free-text field's bound", () => {
  const tools = {
    record_create: KinWorkToolkit.tools.record_create,
    record_update: KinWorkToolkit.tools.record_update,
    record_assign: KinWorkToolkit.tools.record_assign,
    record_hand_back: KinWorkToolkit.tools.record_hand_back,
    doc_create: KinDocsToolkit.tools.doc_create,
  };
  for (const [name, tool] of Object.entries(tools))
    assert.deepStrictEqual(
      unbounded(advertisedJsonSchema(tool)).filter((field) => !FORMATTED.has(field)),
      [],
      name,
    );
});

it("list writers still reject read-only and unknown field types", () => {
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
  for (const type of ["unknown", "number", "yesno"])
    assert.deepStrictEqual(accepted(type), [false, false], type);
});
