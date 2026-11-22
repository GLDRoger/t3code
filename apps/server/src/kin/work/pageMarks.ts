import * as Schema from "effect/Schema";

/**
 * A page's row marks, said once: `sensitiveRows` is "all" or the sensitive rows' keys;
 * `sensitiveFields` is the fields sensitive in every row, or per field the keys it is sensitive in.
 */
export const PageMarks = {
  sensitiveRows: Schema.optional(
    Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)]),
  ),
  sensitiveFields: Schema.optional(
    Schema.Union([
      Schema.Array(Schema.String),
      Schema.Record(Schema.String, Schema.Array(Schema.String)),
    ]),
  ),
};

type Marked = {
  readonly key: string;
  readonly sensitive?: true | undefined;
  readonly sensitiveFields?: ReadonlyArray<string> | undefined;
};
type Bare<R> = Omit<R, "sensitive" | "sensitiveFields">;
type Marks = {
  sensitiveRows?: "all" | ReadonlyArray<string>;
  sensitiveFields?: ReadonlyArray<string> | Record<string, ReadonlyArray<string>>;
};

const sameFields = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((field) => b.includes(field));

/** Rows without their own marks, and the marks that say exactly the same once for the page. */
export const liftMarks = <R extends Marked>(rows: ReadonlyArray<R>): [Array<Bare<R>>, Marks] => {
  const bare = rows.map(({ sensitive: _sensitive, sensitiveFields: _fields, ...row }) => row);
  const sensitive = [...new Set(rows.filter((row) => row.sensitive === true).map((r) => r.key))];
  const fields = rows.map((row) => row.sensitiveFields ?? []);
  const first = fields[0] ?? [];
  const byField: Record<string, Array<string>> = {};
  for (const [index, row] of rows.entries())
    for (const field of fields[index]!) {
      const keys = (byField[field] ??= []);
      if (!keys.includes(row.key)) keys.push(row.key);
    }
  const marks: Marks = {
    ...(sensitive.length === 0
      ? {}
      : { sensitiveRows: rows.every((row) => row.sensitive === true) ? "all" : sensitive }),
    ...(Object.keys(byField).length === 0
      ? {}
      : {
          sensitiveFields: fields.every((one) => sameFields(one, first)) ? [...first] : byField,
        }),
  };
  return [bare, marks];
};
