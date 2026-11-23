import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Expenses gain Funded by, Reimbursement and Repaid on, all or none within 20 fields. A company's
 * own field under one of those keys, of another kind, first moves to a free key with its values,
 * so Money never reads its text as who funded what. Imported partner rows wait for the owner.
 */

const ADDED = [
  { key: "fundedBy", label: "Funded by", type: "person", sensitive: false },
  {
    key: "reimbursement",
    label: "Reimbursement",
    type: "choice",
    choices: ["owed", "repaid", "not reimbursable"],
    sensitive: false,
  },
  { key: "repaidOn", label: "Repaid on", type: "date", sensitive: false },
] as const;
const MAX_FIELDS = 20;
/** A field already under one of Kin's keys that is Kin's own kind: kept, and read as Kin's. */
const sameKind = (own: (typeof ADDED)[number], field: Record<string, unknown>) =>
  field.type === own.type &&
  (!("choices" in own) ||
    (Array.isArray(field.choices) &&
      field.choices.length === own.choices.length &&
      own.choices.every((choice) => (field.choices as ReadonlyArray<unknown>).includes(choice))));

const Definition = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      fields: Schema.Array(
        Schema.StructWithRest(Schema.Struct({ key: Schema.Unknown, label: Schema.Unknown }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
      ),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);
const decodeDefinition = Schema.decodeUnknownOption(Definition);
const encodeDefinition = Schema.encodeEffect(Definition);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lists = yield* sql<{ orgId: string; json: string }>`SELECT org_id AS "orgId",
      definition_json AS json
    FROM kin_registers WHERE register_id = 'expenses' AND built_in = 0 ORDER BY org_id`;
  for (const list of lists) {
    const decoded = decodeDefinition(list.json);
    if (Option.isNone(decoded)) continue;
    const definition = decoded.value;
    const keys = new Set(definition.fields.map((field) => String(field.key)));
    const moved: Array<readonly [string, string]> = [];
    const fields = definition.fields.map((field) => {
      const own = ADDED.find((one) => one.key === field.key);
      if (own === undefined || sameKind(own, field)) return field;
      let free = `${own.key}2`;
      for (let n = 3; keys.has(free); n += 1) free = `${own.key}${n}`;
      keys.add(free);
      moved.push([own.key, free]);
      return { ...field, key: free };
    });
    for (const [from, to] of moved)
      yield* sql`UPDATE kin_records SET fields_json = json_remove(
          json_set(fields_json, ${`$.${to}`}, fields_json -> ${`$.${from}`}), ${`$.${from}`})
        WHERE org_id = ${list.orgId} AND register_id = 'expenses'
          AND json_type(fields_json, ${`$.${from}`}) IS NOT NULL`;
    const missing = ADDED.filter((one) => fields.every((field) => field.key !== one.key));
    const room = fields.length + missing.length <= MAX_FIELDS;
    if (moved.length === 0 && (missing.length === 0 || !room)) continue;
    const json = yield* encodeDefinition({
      ...definition,
      fields: room ? [...fields, ...missing] : fields,
    }).pipe(Effect.orDie);
    yield* sql`UPDATE kin_registers SET definition_json = ${json}, rev = rev + 1
      WHERE org_id = ${list.orgId} AND register_id = 'expenses' AND built_in = 0`;
  }
});
