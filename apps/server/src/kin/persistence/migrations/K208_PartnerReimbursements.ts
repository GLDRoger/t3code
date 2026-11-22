import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Expenses gain Funded by, Reimbursement and Repaid on, all or none within 20 fields; an import's
 * `paidFrom` (where an entry came from) reads Source. Kin keeps no person's address, so a Paid
 * entry an import left `paidPersonallyBy` on is marked owed and matched to nobody.
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
    const fields = definition.fields;
    const missing = ADDED.filter((one) => fields.every((field) => field.key !== one.key));
    const fits = fields.length + missing.length <= MAX_FIELDS;
    const renames = fields.some((field) => field.key === "paidFrom" && field.label === "Paid from");
    const next = [
      ...fields.map((field) =>
        field.key === "paidFrom" && field.label === "Paid from"
          ? { ...field, label: "Source" }
          : field,
      ),
      ...(fits ? missing : []),
    ];
    if (renames || (fits && missing.length > 0)) {
      const json = yield* encodeDefinition({ ...definition, fields: next }).pipe(Effect.orDie);
      yield* sql`UPDATE kin_registers SET definition_json = ${json}, rev = rev + 1
        WHERE org_id = ${list.orgId} AND register_id = 'expenses' AND built_in = 0`;
    }
    const marks = next.some((field) => field.key === "reimbursement");
    if (!marks) continue;
    yield* sql`UPDATE kin_records
      SET fields_json = json_set(fields_json, '$.reimbursement', 'owed'), rev = rev + 1
      WHERE org_id = ${list.orgId} AND register_id = 'expenses' AND state = 'done'
        AND json_valid(fields_json)
        AND trim(COALESCE(json_extract(fields_json, '$.paidPersonallyBy'), '')) <> ''
        AND json_extract(fields_json, '$.reimbursement') IS NULL
        AND json_extract(fields_json, '$.fundedBy') IS NULL`;
  }
});
