import * as Predicate from "effect/Predicate";

export const inputPropertyPaths = (schema: unknown, path = ""): ReadonlySet<string> => {
  if (!Predicate.isObject(schema)) return new Set();
  const properties = Predicate.isObject(schema.properties)
    ? Object.entries(schema.properties).flatMap(([key, value]) => {
        const property = path === "" ? key : `${path}.${key}`;
        return [property, ...inputPropertyPaths(value, property)];
      })
    : [];
  return new Set([
    ...properties,
    ...inputPropertyPaths(schema.items, `${path}[]`),
    ...[schema.anyOf, schema.allOf, schema.oneOf].flatMap((branches) =>
      Array.isArray(branches)
        ? branches.flatMap((branch) => [...inputPropertyPaths(branch, path)])
        : [],
    ),
  ]);
};
