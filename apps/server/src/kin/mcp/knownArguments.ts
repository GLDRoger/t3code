import * as Schema from "effect/Schema";

export const knownArguments = <Fields extends Schema.Struct.Fields>(
  name: string,
  shape: Schema.Struct<Fields>,
) => {
  const keys = Object.keys(shape.fields);
  const accepted = new Set(keys);
  return Schema.StructWithRest(shape, [Schema.Record(Schema.String, Schema.Unknown)]).check(
    Schema.makeFilter((input) => {
      const unexpected = Object.keys(input).find((key) => !accepted.has(key));
      return unexpected === undefined
        ? undefined
        : `${name} takes no ${JSON.stringify(unexpected.slice(0, 64))}; pass one of: ${keys.join(", ")}.`;
    }),
  );
};
