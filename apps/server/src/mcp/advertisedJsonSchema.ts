import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

interface FieldSelection {
  readonly path: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
}

export const AdvertisedDescriptions = Context.Service<ReadonlyArray<FieldSelection>>(
  "t3/mcp/AdvertisedDescriptions",
);

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

// Gemini rejects function declarations whose enums hold anything but strings.
const isNonStringEnum = (key: string, value: Json) =>
  key === "enum" && Array.isArray(value) && value.some((item) => typeof item !== "string");

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const isOpenRest = (value: Json) => {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const [rest] = value;
  return (
    Predicate.isObject(rest) &&
    rest.type === "object" &&
    Object.keys(rest).length === 2 &&
    Predicate.isObject(rest.additionalProperties) &&
    Object.keys(rest.additionalProperties).length === 0
  );
};

const compact = (
  schema: Json,
  optional: boolean,
  options: { readonly kin: boolean; readonly stripOpenRest: boolean },
): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false, options));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    // An open rest schema lets a refinement see extra keys. Its allOf adds no JSON validation.
    if (options.stripOpenRest && key === "allOf" && schema.type === "object" && isOpenRest(value))
      continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    if (isNonStringEnum(key, value)) continue;
    if (
      options.kin &&
      ((key === "minLength" && value === 1) ||
        key === "maxLength" ||
        key === "maxItems" ||
        key === "minItems" ||
        (schema.type === "integer" && (key === "minimum" || key === "maximum")))
    )
      continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name), options),
            ]),
          )
        : options.kin && key === "anyOf" && Array.isArray(value)
          ? value.map((branch) => compact(branch, optional, options))
          : compact(value, false, options);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullSchema(branch)) && !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    const only = branches.length === 1 ? branches[0] : mergeTaggedObjects(branches);
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

const shapeKeywords = new Set([
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "items",
  "anyOf",
  "allOf",
  "oneOf",
  "additionalProperties",
]);

const bareShape = (schema: Json): Json => {
  if (Array.isArray(schema)) return schema.map(bareShape);
  if (!Predicate.isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => shapeKeywords.has(key))
      .map(([key, value]) => [
        key,
        key === "properties" && Predicate.isObject(value)
          ? Object.fromEntries(
              Object.entries(value).map(([name, property]) => [name, bareShape(property)]),
            )
          : key === "enum" || key === "const"
            ? value
            : bareShape(value),
      ]),
  );
};

/**
 * The input schema T3 advertises for a tool. Drops JSON noise that every thread pays for:
 * `additionalProperties: true`, safe-integer bounds, nested `anyOf`, JSON-string fallbacks, and
 * the `null` branch of optional properties. A tagged union of objects becomes one object.
 * Decoding still uses the full schema, so each tag's own required fields still apply.
 */
export const advertisedJsonSchema = (tool: Tool.Any, options?: { readonly kin?: boolean }) => {
  const describedFields = Context.getOrUndefined(tool.annotations, AdvertisedDescriptions);
  const schema = compact(Tool.getJsonSchema(tool), false, {
    kin: options?.kin === true,
    stripOpenRest: describedFields !== undefined,
  });
  for (const { path, keys } of describedFields ?? []) {
    const target = path.reduce<Json>(
      (node, key) => (Predicate.isObject(node) ? node[key] : undefined),
      schema,
    );
    if (!Predicate.isObject(target) || !Predicate.isObject(target.properties))
      throw new Error(`No object for ${tool.name} at ${path.join(".")}.`);
    const described = new Set(keys);
    target.properties = Object.fromEntries(
      Object.entries(target.properties).map(([key, property]) => [
        key,
        described.has(key) ? property : bareShape(property),
      ]),
    );
  }
  return schema as ReturnType<typeof Tool.getJsonSchema>;
};
